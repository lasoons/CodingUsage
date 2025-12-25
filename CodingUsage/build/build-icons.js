const webfont = require('webfont').default;
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src/icons');
const outputDir = path.join(__dirname, '../resources/fonts');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

webfont({
    files: 'src/icons/*.svg',
    fontName: 'coding-usage-icons',
    formats: ['woff'],
    startUnicode: 0xE001,
    verbose: true,
    normalize: true,
    fontHeight: 1000
    // webfont handles glob internally
})
    .then((result) => {
        const dest = path.join(outputDir, 'coding-usage-icons.woff');
        fs.writeFileSync(dest, result.woff);
        console.log('Font generated at', dest);

        // Also save config/map if needed, but we used fixed startUnicode so it should be E001
        // antigravity.svg -> will be mapped to E001 if it's the first file.
        // To be safe, we might want to check the mapping.
        console.log(result.glyphsData);
    })
    .catch((error) => {
        console.error('Font generation failed:', error);
        process.exit(1);
    });
