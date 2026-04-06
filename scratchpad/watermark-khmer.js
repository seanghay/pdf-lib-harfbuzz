const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');

process.env.NODE_PATH = [repoRoot, process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths();

require.extensions['.ts'] = (module, filename) => {
  if (filename.includes('node_modules')) {
    const source = fs.readFileSync(filename, 'utf8');
    module._compile(source, filename);
    return;
  }

  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      importHelpers: false,
    },
    fileName: filename,
  });

  module._compile(outputText, filename);
};

const { degrees, grayscale, PDFDocument, StandardFonts } = require('src/index');

const inputPath = path.join(repoRoot, 'out-khmer.pdf');
const outputPath = path.join(repoRoot, 'out-khmer-watermark.pdf');
const watermarkText = 'CONFIDENTIAL';
const watermarkAngle = 45;

const main = async () => {
  const existingPdfBytes = fs.readFileSync(inputPath);
  const pdfDoc = await PDFDocument.load(existingPdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();
    const diagonal = Math.sqrt(width * width + height * height);
    const fontSize = Math.max(48, Math.min(96, diagonal / 8));
    const textWidth = font.widthOfTextAtSize(watermarkText, fontSize);
    const textHeight = font.heightAtSize(fontSize, { descender: false });
    const radians = (watermarkAngle * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const centerOffsetX = (textWidth * cos - textHeight * sin) / 2;
    const centerOffsetY = (textWidth * sin + textHeight * cos) / 2;

    page.drawText(watermarkText, {
      x: width / 2 - centerOffsetX,
      y: height / 2 - centerOffsetY,
      font,
      size: fontSize,
      rotate: degrees(watermarkAngle),
      color: grayscale(0.75),
      opacity: 0.35,
    });
  }

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, pdfBytes);
  console.log(`Watermarked PDF written to ${outputPath}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
