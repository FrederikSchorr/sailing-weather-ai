import { readFileSync } from "node:fs";

export function gpsJpeg(lat: number, lon: number) {
  const tiff = Buffer.alloc(128);
  tiff.write("II"); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10); tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(4, 26);
  for (const [offset, tag, type, count, value] of [
    [28, 1, 2, 2, lat < 0 ? 83 : 78], [40, 2, 5, 3, 80],
    [52, 3, 2, 2, lon < 0 ? 87 : 69], [64, 4, 5, 3, 104],
  ]) {
    tiff.writeUInt16LE(tag, offset); tiff.writeUInt16LE(type, offset + 2);
    tiff.writeUInt32LE(count, offset + 4); tiff.writeUInt32LE(value, offset + 8);
  }
  for (const [offset, coordinate] of [[80, lat], [104, lon]]) {
    const absolute = Math.abs(coordinate);
    const degrees = Math.floor(absolute);
    const minutes = Math.floor((absolute - degrees) * 60);
    const seconds = ((absolute - degrees) * 60 - minutes) * 60;
    for (const [index, numerator, denominator] of [[0, degrees, 1], [8, minutes, 1], [16, Math.round(seconds * 1e6), 1e6]]) {
      tiff.writeUInt32LE(numerator, offset + index); tiff.writeUInt32LE(denominator, offset + index + 4);
    }
  }
  const app1 = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(app1.length + 2, 4);
  return Buffer.concat([header, app1, Buffer.from([0xff, 0xd9])]);
}

function word(value: number) {
  const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer;
}
function box(type: string, payload: Buffer) {
  return Buffer.concat([word(payload.length + 8), Buffer.from(type), payload]);
}

/** Add an Exif item to a genuine tiny HEIC, retaining its encoded image. */
export function gpsHeic(lat: number, lon: number) {
  const base = readFileSync(new URL("./images/no-metadata.heic", import.meta.url));
  const tiff = gpsJpeg(lat, lon).subarray(12, 140);
  const metadata = Buffer.concat([word(0), tiff]);
  const exifItem = box("infe", Buffer.concat([
    Buffer.from([2, 0, 0, 0, 0, 2, 0, 0]), Buffer.from("ExifExif\0"),
  ]));
  const iinf = box("iinf", Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 2]), base.subarray(131, 152), exifItem,
  ]));
  function meta(imageOffset: number) {
    const iloc = box("iloc", Buffer.concat([
      Buffer.from([0, 0, 0, 0, 0x44, 0x40, 0, 2]),
      Buffer.from([0, 1, 0, 0]), word(imageOffset), Buffer.from([0, 1]), word(0), word(34),
      Buffer.from([0, 2, 0, 0]), word(imageOffset + 34), Buffer.from([0, 1]), word(0), word(metadata.length),
    ]));
    return box("meta", Buffer.concat([
      word(0), base.subarray(36, 83), iloc, iinf, base.subarray(152, 326),
    ]));
  }
  const ftyp = base.subarray(0, 24);
  const header = meta(ftyp.length + meta(0).length + 8);
  return Buffer.concat([ftyp, header, box("mdat", Buffer.concat([base.subarray(334), metadata]))]);
}

/** Extended WebP containing a real encoded 2x2 image and TIFF EXIF. */
export function gpsWebp(lat: number, lon: number) {
  const image = readFileSync(new URL("./images/no-metadata.webp", import.meta.url));
  function chunk(type: string, payload: Buffer) {
    const size = Buffer.alloc(4); size.writeUInt32LE(payload.length);
    return Buffer.concat([Buffer.from(type), size, payload, Buffer.alloc(payload.length % 2)]);
  }
  const dimensions = Buffer.alloc(10);
  dimensions[0] = 8; dimensions[4] = 1; dimensions[7] = 1; // EXIF flag; 2x2 dimensions minus one.
  const payload = Buffer.concat([
    Buffer.from("WEBP"), chunk("VP8X", dimensions), image.subarray(12),
    chunk("EXIF", gpsJpeg(lat, lon).subarray(12, 140)),
  ]);
  const size = Buffer.alloc(4); size.writeUInt32LE(payload.length);
  return Buffer.concat([Buffer.from("RIFF"), size, payload]);
}