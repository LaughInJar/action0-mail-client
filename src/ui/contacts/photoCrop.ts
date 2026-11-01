/** A picture loaded for cropping. */
export interface LoadedPicture {
  /** An object URL to show it (revoke with {@link releasePicture}). */
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly image: HTMLImageElement;
}

/** The part of a picture to keep: a square, in the picture's pixels. */
export interface CropArea {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/** Loads an image file; rejects when it isn't one the browser can read. */
export function loadPicture(blob: Blob): Promise<LoadedPicture> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve({
        url,
        width: image.naturalWidth,
        height: image.naturalHeight,
        image,
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The picture couldn't be read."));
    };
    image.src = url;
  });
}

/** Frees what {@link loadPicture} took. */
export function releasePicture(picture: LoadedPicture): void {
  URL.revokeObjectURL(picture.url);
}

/** The square `area` of the picture as a JPEG of at most `max` pixels a side. */
export function cropPicture(
  picture: LoadedPicture,
  area: CropArea,
  max = 512,
): Promise<Blob> {
  const side = Math.max(1, Math.round(Math.min(max, area.size)));
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("No canvas to crop with."));
  context.imageSmoothingQuality = "high";
  context.drawImage(
    picture.image,
    area.x,
    area.y,
    area.size,
    area.size,
    0,
    0,
    side,
    side,
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The picture couldn't be made."));
      },
      "image/jpeg",
      0.9,
    );
  });
}
