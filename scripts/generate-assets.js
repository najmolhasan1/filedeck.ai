const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function createIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  const bodyBuffers = [];

  for (const item of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(item.width >= 256 ? 0 : item.width, 0);
    entry.writeUInt8(item.height >= 256 ? 0 : item.height, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(item.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    bodyBuffers.push(item.buffer);
    offset += item.buffer.length;
  }

  return Buffer.concat([header, ...entries, ...bodyBuffers]);
}

async function run() {
  console.log('1. Processing logo.png...');
  // Trim transparent padding for UI crispness
  await sharp('logo.png')
    .extract({ left: 122, top: 126, width: 1931, height: 486 })
    .png()
    .toFile('apps/web/public/logo.png');
  fs.copyFileSync('logo.png', 'apps/web/public/logo-original.png');
  console.log('✓ apps/web/public/logo.png created');

  console.log('2. Processing web icons & favicons...');
  await sharp('icon.png').resize(512, 512).png().toFile('apps/web/public/icon.png');
  await sharp('icon.png').resize(192, 192).png().toFile('apps/web/public/icon-192.png');
  await sharp('icon.png').resize(180, 180).png().toFile('apps/web/public/apple-touch-icon.png');
  await sharp('icon.png').resize(32, 32).png().toFile('apps/web/public/favicon.png');

  // Copy to apps/web/app/ for Next.js App Router conventions
  fs.copyFileSync('apps/web/public/icon.png', 'apps/web/app/icon.png');
  fs.copyFileSync('apps/web/public/apple-touch-icon.png', 'apps/web/app/apple-icon.png');

  // Generate multi-size favicon.ico (16, 32, 48)
  const p16 = await sharp('icon.png').resize(16, 16).png().toBuffer();
  const p32 = await sharp('icon.png').resize(32, 32).png().toBuffer();
  const p48 = await sharp('icon.png').resize(48, 48).png().toBuffer();
  const icoBuffer = await createIco([
    { width: 16, height: 16, buffer: p16 },
    { width: 32, height: 32, buffer: p32 },
    { width: 48, height: 48, buffer: p48 }
  ]);
  fs.writeFileSync('apps/web/public/favicon.ico', icoBuffer);
  fs.writeFileSync('apps/web/app/favicon.ico', icoBuffer);
  console.log('✓ Web favicons & icons created');

  console.log('3. Processing Android icons...');
  const resDir = 'apps/web/android/app/src/main/res';
  const densities = [
    { name: 'mipmap-mdpi', launcher: 48, foreground: 108 },
    { name: 'mipmap-hdpi', launcher: 72, foreground: 162 },
    { name: 'mipmap-xhdpi', launcher: 96, foreground: 216 },
    { name: 'mipmap-xxhdpi', launcher: 144, foreground: 324 },
    { name: 'mipmap-xxxhdpi', launcher: 192, foreground: 432 },
  ];

  // Extract the transparent squircle icon from logo.png for adaptive foreground
  const rawSquircle = await sharp('logo.png')
    .extract({ left: 122, top: 126, width: 492, height: 486 })
    .toBuffer();

  for (const d of densities) {
    const dir = path.join(resDir, d.name);
    // 1. ic_launcher.png (legacy launcher)
    await sharp('icon.png')
      .resize(d.launcher, d.launcher)
      .png()
      .toFile(path.join(dir, 'ic_launcher.png'));

    // 2. ic_launcher_round.png (legacy round launcher)
    const circleSvg = `<svg width="${d.launcher}" height="${d.launcher}"><circle cx="${d.launcher / 2}" cy="${d.launcher / 2}" r="${d.launcher / 2}" fill="#fff"/></svg>`;
    const circleMask = Buffer.from(circleSvg);
    await sharp('icon.png')
      .resize(d.launcher, d.launcher)
      .composite([{ input: circleMask, blend: 'dest-in' }])
      .png()
      .toFile(path.join(dir, 'ic_launcher_round.png'));

    // 3. ic_launcher_foreground.png (adaptive foreground)
    const graphicSize = Math.round(d.foreground * 0.66);
    const resizedGraphic = await sharp(rawSquircle)
      .resize(graphicSize, graphicSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();

    await sharp({
      create: {
        width: d.foreground,
        height: d.foreground,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
    .composite([{ input: resizedGraphic, gravity: 'center' }])
    .png()
    .toFile(path.join(dir, 'ic_launcher_foreground.png'));

    console.log(`✓ ${d.name} generated`);
  }

  // Update ic_launcher_background.xml
  const bgXml = '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#F4F4EC</color>\n</resources>\n';
  fs.writeFileSync(path.join(resDir, 'values/ic_launcher_background.xml'), bgXml);
  console.log('✓ ic_launcher_background.xml updated to #F4F4EC');

  console.log('All image assets successfully generated!');
}

run().catch(console.error);
