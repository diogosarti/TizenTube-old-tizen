import base from './rollup.config.js';
import { getBabelOutputPlugin } from '@rollup/plugin-babel';
import terser from '@rollup/plugin-terser';

// Transform the complete bundle, including dependencies, for the 2016 WebKit.
const outputPlugins = [
    getBabelOutputPlugin({
        allowAllFormats: true,
        presets: [['@babel/preset-env', {
            targets: { safari: '5.1' }, modules: false,
            // Symbol shims are objects; changing typeof inside core-js breaks its state checks.
            exclude: ['@babel/plugin-transform-typeof-symbol'],
        }]],
    }),
    terser({ ecma: 5, format: { comments: false } }),
];
// Keep core-js constructor semantics, but copy byte views with the widget's
// native set() instead of assigning every byte in JavaScript.
export function legacyByteArrayCopy() {
    return {
        name: 'legacy-byte-array-copy',
        transform(code, id) {
            if (!id.replace(/\\/g, '/').endsWith('/core-js/internals/array-from-constructor-and-list.js')) return null;
            const loop = '  while (length > index) result[index] = list[index++];';
            if (!code.includes(loop)) throw new Error('Unsupported core-js byte-copy helper');
            return { code: code.replace(loop, `  if (typeof parent !== 'undefined' && parent.__legacyTLS && length === list.length &&
      parent.Object.prototype.toString.call(result) === '[object Uint8Array]' &&
      parent.Object.prototype.toString.call(list) === '[object Uint8Array]') {
    parent.Uint8Array.prototype.set.call(result, list);
    return result;
  }
` + loop), map: null };
        },
    };
}
const plugins = [legacyByteArrayCopy(), ...base.plugins.filter(p => p.name !== 'babel' && p.name !== 'terser')];

export default [
    { ...base, plugins, output: { file: '../legacy/dist/userScript.js', format: 'iife', plugins: outputPlugins } },
    { input: 'legacyDirectBootstrap.js', plugins, output: { file: '../legacy/dist/direct-compat.js', format: 'iife', plugins: outputPlugins } },
];
