#!/usr/bin/env python3
"""Convert the vendored ncnn Real-ESRGAN weights to an ONNX model for the browser.

The Android plugin runs the same weights through ncnn (Vulkan/CPU). The web
build has no ncnn, so it runs the same network through onnxruntime-web instead.
Doing the conversion here — from the .param/.bin pair that already ships with
the app — keeps one source of truth for the weights and dodges the licence
problem of the public anime ONNX files (they ship with no license).

Two properties matter for the browser:

  * **Dynamic axes.** onnxruntime-web tiles a page at whatever size the tile
    budget allows, so H and W must not be baked in. The ncnn graph is fully
    convolutional apart from the input, so this is just how we declare it.
  * **Faithful PReLU.** The per-channel slopes are kept. Folding them into one
    LeakyRelu alpha looked attractive (PReLU is slower on the WebGPU EP) but
    the slopes in these weights range from -1.4 to 1.9, so a mean alpha turns
    the output into noise. Pass `--leaky` to experiment with that anyway.

Usage:
    python3 scripts/ncnn_to_onnx.py \\
        native/real-esrgan/android/src/main/assets/models-realesrgan/models-Real-ESRGANv2-anime/x2 \\
        src/assets/models/realesrgan-anime-x2.onnx [CRD|DCR] [--leaky]
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

MAGIC = 7767517

# ncnn layer type ids (see ncnn's layer_type enum).
T_INPUT = 16
T_SPLIT = 33
T_CONV = 6
T_PRELU = 23
T_PIXELSHUFFLE = 47
T_INTERP = 44
T_BINARYOP = 40


def read_param(path: Path) -> list[tuple[str, str, list[str], list[str], dict[int, list[float]]]]:
    """Parse a .param file into (type, name, bottoms, tops, params) tuples."""
    lines = [l.strip() for l in path.read_text().splitlines() if l.strip()]
    header = lines[0].split()
    if len(header) == 2:
        magic, count = int(header[0]), int(header[1])
        body = lines[1:]
    else:
        # Some exporters split the header over two lines.
        magic = int(header[0])
        # "layers blobs" — only the layer count is ours to check.
        count = int(lines[1].split()[0])
        body = lines[2:]
    if magic != MAGIC:
        raise SystemExit(f"not a ncnn param file (magic {magic})")
    if count != len(body):
        raise SystemExit(f"layer count mismatch: header {count}, body {len(body)}")

    layers = []
    for line in body:
        parts = line.split()
        layer_type, name = parts[0], parts[1]
        bottom_count, top_count = int(parts[2]), int(parts[3])
        bottoms = parts[4 : 4 + bottom_count]
        tops = parts[4 + bottom_count : 4 + bottom_count + top_count]
        params: dict[int, list[float]] = {}
        for raw in parts[4 + bottom_count + top_count :]:
            key, _, value = raw.partition("=")
            params.setdefault(int(key), []).append(float(value))
        layers.append((layer_type, name, bottoms, tops, params))
    return layers


class Bin:
    """Reader for the .bin weight file.

    Mirrors ncnn's `ModelBinFromDataReader::load`:

      * `type 0` (weights) is prefixed by a 4-byte tag: `0x01306B47` = fp16,
        `0x0002C056` = fp32, `0` = raw fp32. fp16 payloads are padded to a
        4-byte boundary.
      * `type 1` (biases, PReLU slopes) is raw fp32 with no tag at all.
    """

    FP16_TAG = 0x01306B47
    FP32_SCALED_TAG = 0x0002C056

    def __init__(self, path: Path) -> None:
        self.data = path.read_bytes()
        self.pos = 0

    def _i32(self) -> int:
        (value,) = struct.unpack_from("<i", self.data, self.pos)
        self.pos += 4
        return value

    def _pad4(self, count: int) -> int:
        return (count + 3) // 4 * 4

    def weights(self, count: int) -> np.ndarray:
        tag = self._i32() & 0xFFFFFFFF
        if tag == self.FP16_TAG:
            size = self._pad4(count * 2)
            values = np.frombuffer(self.data, dtype="<f2", count=count, offset=self.pos)
            self.pos += size
            return values.astype(np.float32).copy()
        if tag == self.FP32_SCALED_TAG:
            values = np.frombuffer(self.data, dtype="<f4", count=count, offset=self.pos)
            self.pos += count * 4
            return values.astype(np.float32).copy()
        if tag == 0:
            values = np.frombuffer(self.data, dtype="<f4", count=count, offset=self.pos)
            self.pos += count * 4
            return values.astype(np.float32).copy()
        raise SystemExit(f"unsupported weight tag 0x{tag:08X} (quantized models are not supported)")

    def raw_floats(self, count: int) -> np.ndarray:
        values = np.frombuffer(self.data, dtype="<f4", count=count, offset=self.pos)
        self.pos += count * 4
        return values.astype(np.float32).copy()


def conv_pads(params: dict[int, list[float]], kernel: int) -> list[int]:
    """SAME-style padding, as ncnn resolves it for this graph."""
    pad = int(params.get(4, [0])[0])
    return [pad, pad, pad, pad] if pad >= 0 else [kernel // 2] * 4


def build(layers, weights: Bin, leaky: bool, pixelshuffle_mode: str) -> onnx.ModelProto:
    nodes: list[onnx.NodeProto] = []
    initializers: list[TensorProto] = []
    alias: dict[str, str] = {}  # ncnn blob -> ONNX tensor
    names: set[str] = set()
    slopes: list[np.ndarray] = []

    def ref(blob: str) -> str:
        return alias.get(blob, blob)

    def unique(base: str) -> str:
        name = base
        i = 1
        while name in names:
            name = f"{base}_{i}"
            i += 1
        names.add(name)
        return name

    for index, (layer_type, name, bottoms, tops, params) in enumerate(layers):
        if layer_type == "Input":
            # ncnn's Input emits the graph input blob; the ONNX input tensor is
            # declared separately and both names point at it.
            alias[tops[0]] = "input"
            continue

        if layer_type == "Split":
            for top in tops:
                alias[top] = ref(bottoms[0])
            continue

        if layer_type == "Convolution":
            num_output = int(params[0][0])
            kernel = int(params.get(1, [1])[0])
            dilation = int(params.get(2, [1])[0])
            stride = int(params.get(3, [1])[0])
            bias_term = int(params.get(5, [0])[0])
            size = int(params.get(6, [0])[0])
            kh = int(params.get(11, [kernel])[0])
            kw = kernel
            weight = weights.weights(size).reshape(num_output, -1, kh, kw)

            w_name = unique(f"W_{index}")
            initializers.append(numpy_helper.from_array(weight, w_name))
            inputs = [ref(bottoms[0]), w_name]
            if bias_term:
                bias = weights.raw_floats(num_output)
                b_name = unique(f"B_{index}")
                initializers.append(numpy_helper.from_array(bias, b_name))
                inputs.append(b_name)
            out = unique(tops[0])
            nodes.append(
                helper.make_node(
                    "Conv",
                    inputs,
                    [out],
                    name=unique(f"conv_{index}"),
                    kernel_shape=[kh, kw],
                    strides=[stride, stride],
                    dilations=[dilation, dilation],
                    pads=conv_pads(params, kernel),
                )
            )
            alias[tops[0]] = out
            continue

        if layer_type == "PReLU":
            count = int(params.get(0, [1])[0])
            slope = weights.raw_floats(count)
            slopes.append(slope)
            out = unique(tops[0])
            if leaky:
                alpha = float(np.mean(slope)) if count > 1 else float(slope[0])
                nodes.append(
                    helper.make_node("LeakyRelu", [ref(bottoms[0])], [out],
                                     name=unique(f"lrelu_{index}"), alpha=alpha)
                )
            else:
                s_name = unique(f"S_{index}")
                initializers.append(
                    numpy_helper.from_array(slope.reshape(-1, 1, 1), s_name)
                )
                nodes.append(
                    helper.make_node("PRelu", [ref(bottoms[0]), s_name], [out],
                                     name=unique(f"prelu_{index}"))
                )
            alias[tops[0]] = out
            continue

        if layer_type == "PixelShuffle":
            scale = int(params.get(0, [1])[0])
            out = unique(tops[0])
            nodes.append(
                helper.make_node(
                    "DepthToSpace",
                    [ref(bottoms[0])],
                    [out],
                    name=unique(f"pixel_shuffle_{index}"),
                    blocksize=scale,
                    mode=pixelshuffle_mode,
                )
            )
            alias[tops[0]] = out
            continue

        if layer_type == "Interp":
            height_scale = float(params.get(1, [1])[0])
            width_scale = float(params.get(2, [1])[0])
            out = unique(tops[0])
            scales_name = unique(f"scales_{index}")
            initializers.append(
                numpy_helper.from_array(
                    np.array([1.0, 1.0, height_scale, width_scale], dtype=np.float32),
                    scales_name,
                )
            )
            # ncnn resize_type 1 (the value this graph carries) is nearest.
            # ONNX Resize inputs are (X, roi, scales, sizes): scales is third.
            nodes.append(
                helper.make_node(
                    "Resize",
                    [ref(bottoms[0]), "", scales_name],
                    [out],
                    name=unique(f"interp_{index}"),
                    mode="nearest",
                    coordinate_transformation_mode="asymmetric",
                    nearest_mode="floor",
                )
            )
            alias[tops[0]] = out
            continue

        if layer_type == "BinaryOp":
            op = int(params.get(0, [0])[0])
            if op != 0:
                raise SystemExit(f"unsupported BinaryOp type {op}")
            out = unique(tops[0])
            nodes.append(
                helper.make_node(
                    "Add",
                    [ref(bottoms[0]), ref(bottoms[1])],
                    [out],
                    name=unique(f"add_{index}"),
                )
            )
            alias[tops[0]] = out
            continue

        raise SystemExit(f"unsupported layer type {layer_type} ({name})")

    output = ref("output")
    graph = helper.make_graph(
        nodes,
        "realesrgan_anime_x2",
        [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, "H", "W"])],
        [helper.make_tensor_value_info(output, TensorProto.FLOAT, [1, 3, "2H", "2W"])],
        initializers,
    )
    model = helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 13)],
        ir_version=8,
        producer_name="emaki-ncnn2onnx",
    )
    onnx.checker.check_model(model, full_check=False)
    if slopes:
        stacked = np.concatenate([s.ravel() for s in slopes])
        note = "folded to LeakyRelu" if leaky else "kept as per-channel PReLU"
        print(
            f"  PReLU slopes {note}: mean={stacked.mean():.4f} "
            f"range=[{stacked.min():.4f}, {stacked.max():.4f}]"
        )
    print(f"  {len(nodes)} nodes, {len(initializers)} initializers, output '{output}'")
    return model


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    base = Path(sys.argv[1])
    out = Path(sys.argv[2])
    param = base if base.suffix == ".param" else Path(f"{base}.param")
    binary = base if base.suffix == ".bin" else Path(f"{base}.bin")
    layers = read_param(param)
    weights = Bin(binary)
    print(f"read {param.name} ({len(layers)} layers) + {binary.name}")

    # DepthToSpace ordering: ncnn's mode 0 picks channel
    # `c*r*r + sh*r + sw`, which is exactly ONNX's DCR.
    args = [a for a in sys.argv[3:] if not a.startswith("--")]
    mode = args[0] if args else "DCR"
    leaky = "--leaky" in sys.argv
    model = build(layers, weights, leaky=leaky, pixelshuffle_mode=mode)
    out.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, out)
    print(f"wrote {out} ({out.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
