const esbuild = require('esbuild');
const { copy } = require('esbuild-plugin-copy');

//@ts-check
/** @typedef {import('esbuild').BuildOptions} BuildOptions **/

/** @type BuildOptions */
const baseConfig = {
  bundle: true,
  minify: true, // 总是启用压缩
  sourcemap: false, // 生产环境不需要 sourcemap
  treeShaking: true, // 启用 tree shaking
  target: 'node16', // 指定目标 Node.js 版本
};

// Config for extension source code (to be run in a Node-based context)
const extensionConfig = {
  ...baseConfig,
  platform: 'node',
  mainFields: ['module', 'main'],
  format: 'cjs',
  entryPoints: ['./src/extension.ts'],
  outfile: './out/extension.js',
  external: ['vscode'],
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  drop: ['console', 'debugger'],
  plugins: [
    copy({
      assets: [
        { from: 'node_modules/sql.js/dist/sql-wasm.wasm', to: './out' }
      ]
    })
  ]
};

// Build start
console.log('Building...');

// Build extension
esbuild
  .build(extensionConfig)
  .then(() => {
    console.log('Build complete!');
  })
  .catch(() => process.exit(1));
