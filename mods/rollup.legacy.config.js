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
const plugins = base.plugins.filter(p => p.name !== 'babel' && p.name !== 'terser');

export default [
    { ...base, plugins, output: { file: '../legacy/dist/userScript.js', format: 'iife', plugins: outputPlugins } },
    { input: 'legacyDirectBootstrap.js', plugins, output: { file: '../legacy/dist/direct-compat.js', format: 'iife', plugins: outputPlugins } },
];
