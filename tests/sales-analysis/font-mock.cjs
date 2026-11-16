// Next公式のフォント応答差し替え口。Googleへ接続しない。
module.exports = new Proxy({}, { get: (_, url) => typeof url === 'string' ? '@font-face { font-family: "Offline Geist"; src: url(https://offline.invalid/mock.woff2) format("woff2"); font-weight: 100 900; }' : undefined });
