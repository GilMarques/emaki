use anyhow::Result;
use image::{Rgb, RgbImage};
use ndarray::Array4;
use ort::session::Session;
use ort::value::{TensorRef, ValueType};
use std::sync::atomic::{AtomicBool, Ordering};

/// Fallback tile size (input side) used when a model's ONNX input is dynamic
/// (no fixed spatial dimension). Fully-convolutional Real-ESRGAN variants are
/// seamless at any tile size, so this is safe for the x2/x4 "plus" nets.
const DEFAULT_TILE_IN: usize = 256;

/// Run Real-ESRGAN over an image by tiling it into `tile_in` windows, upscaling
/// each independently, and stitching the `tile_out = tile_in * scale` results.
///
/// The tile geometry and scale are **model-agnostic**:
///   * `tile_in` comes from the model's fixed ONNX input height when present
///     (e.g. `real_esrgan_x4plus` is locked to 128). Dynamic-input models
///     (e.g. `Real-ESRGAN_x2plus`) fall back to `DEFAULT_TILE_IN`.
///   * `scale` is the upscale factor requested by the caller (2 or 4), matching
///     the bundled weights.
///
/// RRDB-family nets have no spatial padding, so non-overlapping tiles are
/// seamless; partial boundary tiles are edge-clamped to the required size and
/// only the valid region is copied out. `cancel` is checked between tiles so a
/// cancelled job stops promptly and the caller can drop the partial output.
pub fn enhance_image(
    session: &mut Session,
    input: &[u8],
    scale: usize,
    cancel: &AtomicBool,
) -> Result<(Vec<u8>, u32, u32)> {
    // Read the model's input spatial dimension so we tile at the size the net
    // was exported for. A dynamic-input model (e.g. `Real-ESRGAN_x2plus`)
    // returns 0, in which case we fall back to `DEFAULT_TILE_IN`.
    let raw_tile = model_input_size(session);
    let tile_in = if raw_tile == 0 { DEFAULT_TILE_IN } else { raw_tile };
    let tile_out = tile_in * scale;
    if cancel.load(Ordering::SeqCst) {
        anyhow::bail!("cancelled");
    }

    let img = image::load_from_memory(input)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?
        .to_rgb8();
    let (w, h) = (img.width() as usize, img.height() as usize);

    let mut out_img = RgbImage::new((w * scale) as u32, (h * scale) as u32);

    for y in (0..h).step_by(tile_in) {
        for x in (0..w).step_by(tile_in) {
            if cancel.load(Ordering::SeqCst) {
                anyhow::bail!("cancelled");
            }

            let tw = (w - x).min(tile_in);
            let th = (h - y).min(tile_in);

            // Build a TILE_IN x TILE_IN NCHW f32 [0,1] tile, edge-clamped from source.
            let mut data = vec![0f32; tile_in * tile_in * 3];
            for ty in 0..tile_in {
                for tx in 0..tile_in {
                    let sx = (x + tx).min(w - 1);
                    let sy = (y + ty).min(h - 1);
                    let px = img.get_pixel(sx as u32, sy as u32);
                    let base = ty * tile_in + tx;
                    data[base] = px[0] as f32 / 255.0;
                    data[base + tile_in * tile_in] = px[1] as f32 / 255.0;
                    data[base + 2 * tile_in * tile_in] = px[2] as f32 / 255.0;
                }
            }
            let input_tensor = Array4::from_shape_vec((1, 3, tile_in, tile_in), data)
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;

            let input_name = session.inputs()[0].name().to_string();
            let output_name = session.outputs()[0].name().to_string();
            let outputs = session
                .run(ort::inputs![&input_name => TensorRef::from_array_view(&input_tensor)?])
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;

            let (_shape, out_data) = outputs[&*output_name]
                .try_extract_tensor::<f32>()
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;

            let expected = 3 * tile_out * tile_out;
            if out_data.len() != expected {
                anyhow::bail!("unexpected model output size: {}", out_data.len());
            }
            let out_tile = tensor_to_image(out_data, tile_out);

            // Copy only the valid (tw*scale, th*scale) region into the output.
            let ow = tw * scale;
            let oh = th * scale;
            for oy in 0..oh {
                for ox in 0..ow {
                    let p = *out_tile.get_pixel(ox as u32, oy as u32);
                    out_img.put_pixel((x * scale + ox) as u32, (y * scale + oy) as u32, p);
                }
            }
        }
    }

    if cancel.load(Ordering::SeqCst) {
        anyhow::bail!("cancelled");
    }

    let mut buf = Vec::new();
    out_img
        .write_to(
            &mut std::io::Cursor::new(&mut buf),
            image::ImageFormat::Png,
        )
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;

    Ok((buf, (w * scale) as u32, (h * scale) as u32))
}

/// Input spatial size (height == width for these nets) the ONNX export expects,
/// or `0` when the input uses dynamic axes. Dims come back as `i64` with `-1`
/// meaning "free"; we read the H (index 2) of `[1,3,H,W]`.
fn model_input_size(session: &Session) -> usize {
    match session.inputs().first().map(|i| i.dtype()) {
        Some(ValueType::Tensor { shape, .. }) => {
            // `Shape` derefs to `[i64]`; index 2 is the height of `[1,3,H,W]`.
            if shape.len() == 4 && shape[2] > 0 {
                shape[2] as usize
            } else {
                0
            }
        }
        _ => 0,
    }
}

/// Convert a flat NCHW f32 [0,1] buffer of size `(1,3,size,size)` to an RGB image.
fn tensor_to_image(data: &[f32], size: usize) -> RgbImage {
    let mut img = RgbImage::new(size as u32, size as u32);
    let ch = size * size;
    for yy in 0..size {
        for xx in 0..size {
            let base = yy * size + xx;
            let r = (data[base].clamp(0.0, 1.0) * 255.0) as u8;
            let g = (data[base + ch].clamp(0.0, 1.0) * 255.0) as u8;
            let b = (data[base + 2 * ch].clamp(0.0, 1.0) * 255.0) as u8;
            img.put_pixel(xx as u32, yy as u32, Rgb([r, g, b]));
        }
    }
    img
}
