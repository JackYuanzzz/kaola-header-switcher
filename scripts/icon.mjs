import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Mechanical size conversion only: preserve the generated artwork and its alpha.
export async function writeIcons(directory) {
  await mkdir(directory, { recursive: true });
  const source = fileURLToPath(new URL('../assets/koala-icon.png', import.meta.url));
  await Promise.all([16, 32, 48, 128].map((size) =>
    sharp(source)
      .resize(size, size, { fit: 'contain', background: '#00000000' })
      .png()
      .toFile(fileURLToPath(new URL(`icon-${size}.png`, directory))),
  ));
}
