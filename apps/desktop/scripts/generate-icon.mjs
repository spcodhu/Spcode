import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const buildDir = fileURLToPath(new URL("../build/", import.meta.url));
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

async function render(directory) {
  const { app, BrowserWindow } = electron;
  app.setPath("userData", join(directory, "user-data"));
  app.setPath("sessionData", join(directory, "session-data"));
  await app.whenReady();
  app.dock?.hide();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await window.loadURL("data:text/html,<html><body></body></html>");
    const svg = readFileSync(join(buildDir, "icon.svg"), "utf8");
    const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const images = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(source)};
      await image.decode();
      return ${JSON.stringify(sizes)}.map(size => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        canvas.getContext("2d").drawImage(image, 0, 0, size, size);
        return canvas.toDataURL("image/png").split(",")[1];
      });
    })()`);
    for (const [index, size] of sizes.entries()) {
      writeFileSync(join(directory, `${size}.png`), Buffer.from(images[index], "base64"));
    }
  } finally {
    window.destroy();
  }
}

function createIco(directory) {
  const windowsSizes = sizes.filter((size) => size <= 256);
  const header = Buffer.alloc(6 + windowsSizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(windowsSizes.length, 4);
  let offset = header.length;
  const images = windowsSizes.map((size, index) => {
    const image = readFileSync(join(directory, `${size}.png`));
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
    return image;
  });
  writeFileSync(join(directory, "icon.ico"), Buffer.concat([header, ...images]));
}

function generate() {
  if (process.platform !== "darwin") throw new Error("ICNS generation requires macOS iconutil.");
  const directory = mkdtempSync(join(tmpdir(), "spcode-icons-"));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFileSync(electron, [fileURLToPath(import.meta.url), directory], {
      env,
      stdio: "inherit",
      timeout: 60_000,
    });
    const iconset = join(directory, "icon.iconset");
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      copyFileSync(join(directory, `${size}.png`), join(iconset, `icon_${size}x${size}.png`));
      copyFileSync(join(directory, `${size * 2}.png`), join(iconset, `icon_${size}x${size}@2x.png`));
    }
    execFileSync("iconutil", ["--convert", "icns", "--output", join(directory, "icon.icns"), iconset]);
    createIco(directory);
    copyFileSync(join(directory, "1024.png"), join(buildDir, "icon.png"));
    for (const name of ["icon.icns", "icon.ico"]) {
      copyFileSync(join(directory, name), join(buildDir, name));
    }
    console.log("Generated icon.png (1024), icon.icns (16–1024), icon.ico (16–256) from icon.svg.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.versions.electron) {
  render(process.argv[2]).then(
    () => electron.app.exit(0),
    (error) => {
      console.error(error);
      electron.app.exit(1);
    },
  );
} else {
  generate();
}
