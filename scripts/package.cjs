const { packager } = require('@electron/packager');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const staging = fs.mkdtempSync(path.join(root, 'work', 'package-'));
  fs.cpSync(path.join(root, 'dist'), path.join(staging, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: manifest.name, productName: manifest.productName,
    version: manifest.version, description: manifest.description, main: manifest.main, license: manifest.license }, null, 2));
  const buildOutput = fs.mkdtempSync(path.join(root, 'work', 'distribution-'));
  const paths = await packager({
    dir: staging, name: 'SAGE Presenter', executableName: 'SAGE Presenter', electronVersion: manifest.devDependencies.electron,
    platform: process.platform, arch: process.arch, out: buildOutput,
    overwrite: true, asar: true, icon: path.join(root, 'assets', 'icon.ico'),
    appCopyright: 'SAGE Presenter contributors; CC0-1.0', prune: false
  });
  const destinations = [];
  for (const directory of paths) {
    for (const filename of ['config.second.example.json', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'Send-Command.ps1']) fs.copyFileSync(path.join(root, filename), path.join(directory, filename));
    fs.copyFileSync(path.join(root, 'config.example.json'), path.join(directory, 'config.json'));
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(directory, 'LICENSE.sage-presenter.txt'));
    fs.cpSync(path.join(root, 'docs'), path.join(directory, 'docs'), { recursive:true });
    fs.mkdirSync(path.join(directory, 'tests'), { recursive:true });
    fs.copyFileSync(path.join(root, 'tests', 'README.md'), path.join(directory, 'tests', 'README.md'));
    const destination = path.join(root, 'output', path.basename(directory));
    const existingConfigPath = path.join(destination, 'config.json');
    let existingConfig;
    if (fs.existsSync(existingConfigPath)) {
      const defaults = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
      existingConfig = { ...defaults, ...JSON.parse(fs.readFileSync(existingConfigPath, 'utf8').replace(/^\uFEFF/, '')) };
      delete existingConfig.startupUrl;
    }
    // Overlay product files instead of deleting the portable folder and its user data.
    fs.cpSync(directory, destination, { recursive: true });
    if (existingConfig) fs.writeFileSync(existingConfigPath, JSON.stringify(existingConfig, null, 2) + '\n');
    destinations.push(destination);
  }
  console.log(destinations.join('\n'));
})().catch(error => { console.error(error); process.exitCode = 1; });
