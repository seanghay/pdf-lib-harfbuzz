import { Font, Glyph, Subset, TypeFeatures } from 'src/types/fontkit';

import CustomFontEmbedder from 'src/core/embedders/CustomFontEmbedder';
import {
  attachEncodedTextRun,
  EncodedGlyph,
} from 'src/core/embedders/EncodedText';
import HarfBuzzEmbeddedFont from 'src/core/harfbuzz/HarfBuzzFont';
import PDFHexString from 'src/core/objects/PDFHexString';
import PDFRef from 'src/core/objects/PDFRef';
import PDFString from 'src/core/objects/PDFString';
import PDFContext from 'src/core/PDFContext';
import { Cache, mergeUint8Arrays, toHexStringOfMinLength } from 'src/utils';

/**
 * A note of thanks to the developers of https://github.com/foliojs/pdfkit, as
 * this class borrows from:
 *   https://github.com/devongovett/pdfkit/blob/e71edab0dd4657b5a767804ba86c94c58d01fbca/lib/image/jpeg.coffee
 */
class CustomFontSubsetEmbedder extends CustomFontEmbedder {
  static async for(
    fontDataOrFontkit: Uint8Array | unknown,
    fontDataOrCustomName?: Uint8Array | string,
    customNameOrFeatures?: string | TypeFeatures,
    fontFeatures?: TypeFeatures,
  ) {
    const {
      fontData,
      customName,
      resolvedFontFeatures,
    } = parseCreateArgs(
      fontDataOrFontkit,
      fontDataOrCustomName,
      customNameOrFeatures,
      fontFeatures,
    );
    return new CustomFontSubsetEmbedder(
      await HarfBuzzEmbeddedFont.create(fontData),
      fontData,
      customName,
      resolvedFontFeatures,
    );
  }

  private readonly subset: Subset;
  private readonly glyphs: Glyph[];
  private readonly glyphIdMap: Map<number, number>;

  private constructor(
    font: Font,
    fontData: Uint8Array,
    customFontName?: string,
    fontFeatures?: TypeFeatures,
  ) {
    super(font, fontData, customFontName, fontFeatures);

    this.subset = this.font.createSubset();
    this.glyphs = [];
    this.glyphCache = Cache.populatedBy(() => this.glyphs);
    this.glyphIdMap = new Map();
  }

  encodeText(text: string): PDFHexString {
    const { glyphs, positions } = this.layout(text);
    const hexCodes = new Array(glyphs.length);
    const encodedGlyphs = new Array(glyphs.length) as EncodedGlyph[];

    for (let idx = 0, len = glyphs.length; idx < len; idx++) {
      const glyph = glyphs[idx];
      const position = positions[idx];
      const subsetGlyphId = this.subset.includeGlyph(glyph);
      const hexCode = toHexStringOfMinLength(subsetGlyphId, 4);

      this.glyphs[subsetGlyphId - 1] = glyph;
      this.glyphIdMap.set(glyph.id, subsetGlyphId);

      hexCodes[idx] = hexCode;
      encodedGlyphs[idx] = {
        encoded: PDFHexString.of(hexCode),
        xAdvance: position.xAdvance * this.scale,
        yAdvance: position.yAdvance * this.scale,
        xOffset: position.xOffset * this.scale,
        yOffset: position.yOffset * this.scale,
      };
    }

    this.glyphCache.invalidate();
    return attachEncodedTextRun(PDFHexString.of(hexCodes.join('')), {
      glyphs: encodedGlyphs,
      advanceWidth: sumAdvances(positions, 'xAdvance') * this.scale,
      advanceHeight: sumAdvances(positions, 'yAdvance') * this.scale,
    });
  }

  protected isCFF(): boolean {
    return (this.subset as any).cff;
  }

  protected async embedCIDFontDict(context: PDFContext): Promise<PDFRef> {
    const fontDescriptorRef = await this.embedFontDescriptor(context);
    const cidToGidMapRef = this.embedCidToGidMap(context);

    const cidFontDict = context.obj({
      Type: 'Font',
      Subtype: this.isCFF() ? 'CIDFontType0' : 'CIDFontType2',
      CIDToGIDMap: cidToGidMapRef,
      BaseFont: this.baseFontName,
      CIDSystemInfo: {
        Registry: PDFString.of('Adobe'),
        Ordering: PDFString.of('Identity'),
        Supplement: 0,
      },
      FontDescriptor: fontDescriptorRef,
      W: this.computeWidths(),
    });

    return context.register(cidFontDict);
  }

  protected glyphId(glyph?: Glyph): number {
    return glyph ? this.glyphIdMap.get(glyph.id)! : -1;
  }

  protected serializeFont(): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const parts: Uint8Array[] = [];
      this.subset
        .encodeStream()
        .on('data', (bytes) => parts.push(bytes))
        .on('end', () => resolve(mergeUint8Arrays(parts)))
        .on('error' as any, (err) => reject(err));
    });
  }

  private embedCidToGidMap(context: PDFContext): PDFRef {
    const bytes = new Uint8Array((this.glyphs.length + 1) * 2);

    for (let cid = 1, len = this.glyphs.length; cid <= len; cid++) {
      const glyph = this.glyphs[cid - 1];
      if (!glyph) continue;

      const offset = cid * 2;
      bytes[offset] = (glyph.id >> 8) & 0xff;
      bytes[offset + 1] = glyph.id & 0xff;
    }

    return context.register(context.flateStream(bytes));
  }
}

export default CustomFontSubsetEmbedder;

const sumAdvances = (
  positions: {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }[],
  key: 'xAdvance' | 'yAdvance',
) => {
  let total = 0;
  for (let idx = 0, len = positions.length; idx < len; idx++) {
    total += positions[idx][key];
  }
  return total;
};

const parseCreateArgs = (
  fontDataOrFontkit: Uint8Array | unknown,
  fontDataOrCustomName?: Uint8Array | string,
  customNameOrFeatures?: string | TypeFeatures,
  fontFeatures?: TypeFeatures,
) => {
  if (fontDataOrFontkit instanceof Uint8Array) {
    return {
      fontData: fontDataOrFontkit,
      customName:
        typeof fontDataOrCustomName === 'string'
          ? fontDataOrCustomName
          : undefined,
      resolvedFontFeatures: customNameOrFeatures as TypeFeatures | undefined,
    };
  }

  return {
    fontData: fontDataOrCustomName as Uint8Array,
    customName: customNameOrFeatures as string | undefined,
    resolvedFontFeatures: fontFeatures,
  };
};
