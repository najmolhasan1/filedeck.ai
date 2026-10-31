import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { sniffPreview } from '../src/preview.js';

test('preview sniffing never renders HTML or SVG just because a filename claims an image',()=>{
  for(const body of ['<html><script>alert(1)</script>','<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>','<?xml version="1.0"?><svg/>','javascript:alert(1)'])assert.equal(sniffPreview(Buffer.from(body)),null);
  assert.equal(sniffPreview(Buffer.from([137,80,78,71,13,10,26,10])),'image/png');
  assert.equal(sniffPreview(Buffer.from('%PDF-1.7\n')),'application/pdf');
  assert.equal(sniffPreview(Buffer.from('RIFF0000WEBPVP8 ')),'image/webp');
});
