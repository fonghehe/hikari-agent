import sharp from 'sharp';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = await readFile(new URL('../public/hikari-icon.svg', import.meta.url));
const directory = new URL('../resources/icons/', import.meta.url);
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await sharp(source)
  .png()
  .toFile(fileURLToPath(new URL('hikari.png', directory)));
const sizes = [16, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map((size) => sharp(source).resize(size).png().toBuffer()));
const icoHeader = Buffer.alloc(6 + sizes.length * 16);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(sizes.length, 4);
let offset = icoHeader.length;
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  icoHeader[entry] = icoHeader[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
  icoHeader.writeUInt16LE(1, entry + 4);
  icoHeader.writeUInt16LE(32, entry + 6);
  icoHeader.writeUInt32LE(image.length, entry + 8);
  icoHeader.writeUInt32LE(offset, entry + 12);
  offset += image.length;
});
await writeFile(new URL('hikari.ico', directory), Buffer.concat([icoHeader, ...images]));
const chunks = await Promise.all(
  [
    [16, 'icp4'],
    [32, 'icp5'],
    [64, 'icp6'],
    [128, 'ic07'],
    [256, 'ic08'],
    [512, 'ic09'],
    [1024, 'ic10'],
  ].map(async ([size, tag]) => {
    const image = await sharp(source).resize(size).png().toBuffer();
    const header = Buffer.alloc(8);
    header.write(tag);
    header.writeUInt32BE(image.length + 8, 4);
    return Buffer.concat([header, image]);
  }),
);
const header = Buffer.alloc(8);
header.write('icns');
header.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4);
await writeFile(new URL('hikari.icns', directory), Buffer.concat([header, ...chunks]));
console.log('Hikari icons generated: PNG, ICO, ICNS.');
