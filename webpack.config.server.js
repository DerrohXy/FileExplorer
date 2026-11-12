const path = require("path");
const nodeExternals = require("webpack-node-externals");
const WebpackObfuscator = require("webpack-obfuscator");

module.exports = {
    target: "node",
    entry: "./src/server.tsx",
    output: {
        path: path.resolve(__dirname, "build"),
        filename: "server.js",
    },
    resolve: {
        extensions: [".ts", ".tsx", ".js", ".jsx"],
    },
    externals: [nodeExternals()],
    module: {
        rules: [
            {
                test: /\.(ts|tsx)$/,
                exclude: /node_modules/,
                use: "ts-loader",
            },
            {
                test: /\.(js|jsx)$/,
                exclude: /node_modules/,
                use: "babel-loader",
            },
        ],
    },
    mode: "production",
    plugins: [
        new WebpackObfuscator(
            {
                rotateStringArray: true,
                stringArrayEncoding: ["base64"],
            },
            [],
        ),
    ],
};
