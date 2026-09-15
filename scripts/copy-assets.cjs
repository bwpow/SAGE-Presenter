const fs = require('node:fs');
for (const name of ['index.html', 'style.css', 'icon.png']) {
  fs.copyFileSync(`assets/${name}`, `dist/${name}`);
}
