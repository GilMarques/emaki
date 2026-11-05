import { normalizePageLayout, normalizeZoom, transitionForMode } from './settings.model';

describe('normalizePageLayout', () => {
  it('keeps the three page layouts', () => {
    expect(normalizePageLayout('auto')).toBe('auto');
    expect(normalizePageLayout('single')).toBe('single');
    expect(normalizePageLayout('dual')).toBe('dual');
  });

  it('maps the old control values onto Auto, Single page, and Dual page', () => {
    expect(normalizePageLayout('default')).toBe('auto');
    expect(normalizePageLayout('auto-switch')).toBe('auto');
    expect(normalizePageLayout('auto-single')).toBe('single');
    expect(normalizePageLayout('auto-dual')).toBe('dual');
  });

  it('rejects anything else', () => {
    expect(normalizePageLayout('spread')).toBeNull();
    expect(normalizePageLayout(1)).toBeNull();
  });
});

describe('transitionForMode', () => {
  it('binds the page turn to the viewer mode', () => {
    expect(transitionForMode('paged')).toBe('page-curl');
    expect(transitionForMode('vertical-scroll')).toBe('slide-vertical');
    expect(transitionForMode('horizontal-scroll')).toBe('slide-horizontal');
  });
});

describe('normalizeZoom', () => {
  it('keeps fit to screen, width, and height', () => {
    expect(normalizeZoom('fit-screen')).toBe('fit-screen');
    expect(normalizeZoom('fit-width')).toBe('fit-width');
    expect(normalizeZoom('fit-height')).toBe('fit-height');
  });

  it('loads the removed zoom modes as fit to screen', () => {
    expect(normalizeZoom('actual-size')).toBe('fit-screen');
    expect(normalizeZoom('fixed-size')).toBe('fit-screen');
    expect(normalizeZoom('stretch-to-fill')).toBe('fit-screen');
    expect(normalizeZoom('cover')).toBe('fit-screen');
  });
});
