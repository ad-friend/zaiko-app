// Turbopackは列挙可能なURL辞書が必要。フォント本体の取得は発生させない。
module.exports = Object.fromEntries(['Geist','Geist+Mono'].map(family => [
 `https://fonts.googleapis.com/css2?family=${family}:wght@100..900&display=swap`,
 `@font-face { font-family: '${family.replace('+',' ')}'; font-weight: 100 900; font-style: normal; src: local('Arial'); }`
]));
