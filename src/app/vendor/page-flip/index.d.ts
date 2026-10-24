export interface Point {
  x: number;
  y: number;
}

export interface PageRect {
  left: number;
  top: number;
  width: number;
  height: number;
  pageWidth: number;
}

export type FlipSetting = {
  startPage: number;
  size: 'fixed' | 'stretch';
  width: number;
  height: number;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  drawShadow: boolean;
  flippingTime: number;
  usePortrait: boolean;
  startZIndex: number;
  autoSize: boolean;
  maxShadowOpacity: number;
  showCover: boolean;
  mobileScrollSupport: boolean;
  clickEventForward: boolean;
  useMouseEvents: boolean;
  swipeDistance: number;
  showPageCorners: boolean;
  disableFlipByClick: boolean;
};

export interface FlipEvent {
  data: unknown;
  object: unknown;
}

export interface FlipController {
  getState(): string;
  getCalculation(): {
    getPosition(): Point;
    getDirection(): number;
  } | null;
}

export interface FlipUI {
  getDistElement(): HTMLElement;
  destroy(): void;
}

/** Page collection as exposed by the lib: spreads hold rendered-page indices. */
export interface FlipPageCollection {
  getSpread(): readonly (readonly number[])[];
  getSpreadIndexByPage(page: number): number | null;
  getCurrentPageIndex(): number;
}

export class PageFlip {
  constructor(inBlock: HTMLElement, setting: Partial<FlipSetting>);
  on(event: string, callback: (e: FlipEvent) => void): void;
  off(event: string): void;
  destroy(): void;
  update(): void;
  loadFromImages(imagesHref: string[]): void;
  loadFromHTML(items: NodeListOf<HTMLElement> | HTMLElement[]): void;
  turnToPage(page: number): void;
  flipNext(corner?: string): void;
  flipPrev(corner?: string): void;
  flip(page: number, corner?: string): void;
  updateState(state: string): void;
  startUserTouch(pos: Point): void;
  userMove(pos: Point, isTouch: boolean): void;
  userStop(pos: Point, isSwipe?: boolean): void;
  getPageCount(): number;
  getCurrentPageIndex(): number;
  getPageCollection(): FlipPageCollection;
  getOrientation(): 'portrait' | 'landscape';
  getFlipController(): FlipController;
  getBoundsRect(): PageRect;
  getSettings(): Readonly<FlipSetting>;
  getUI(): FlipUI;
  getState(): string;
}
