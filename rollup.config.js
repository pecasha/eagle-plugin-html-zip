import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import terser from "@rollup/plugin-terser";

const isProd = process.title.includes("--prod");

export default [
    {
        input: "src/core/index.ts",
        output: {
            file: "build/core.js",
            format: "cjs"
        },
        plugins: [
            typescript({
                tsconfig: "tsconfig.json"
            }),
            resolve(),
            commonjs(),
            terser({
                compress: {
                    drop_debugger: isProd
                }
            })
        ]
    }
];
