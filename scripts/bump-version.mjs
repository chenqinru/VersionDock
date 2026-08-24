#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const packageJsonPath = path.join(rootDir, 'package.json');
const packageLockJsonPath = path.join(rootDir, 'package-lock.json');
const readmePath = path.join(rootDir, 'README.md');

// ANSI 颜色输出辅助函数
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

function parseSemver(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || undefined,
  };
}

function getBumpOptions(currentVersion) {
  const parsed = parseSemver(currentVersion);
  if (!parsed) return null;
  return {
    patch: `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`,
    minor: `${parsed.major}.${parsed.minor + 1}.0`,
    major: `${parsed.major + 1}.0.0`,
  };
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function resolveTargetVersion(currentVersion) {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const options = getBumpOptions(currentVersion);

  if (args.length > 0) {
    const input = args[0].toLowerCase();
    if (options && input === 'patch') return options.patch;
    if (options && input === 'minor') return options.minor;
    if (options && input === 'major') return options.major;
    if (parseSemver(args[0])) return args[0];

    console.error(`${colors.red}❌ 无效的版本号格式: "${args[0]}" (需符合 SemVer 规范，例如 1.2.3 或 1.2.3-beta.1)${colors.reset}`);
    process.exit(1);
  }

  console.log(`\n${colors.cyan}${colors.bright}📦 VersionDock 版本更新工具${colors.reset}`);
  console.log(`${colors.gray}当前版本:${colors.reset} ${colors.yellow}${colors.bright}${currentVersion}${colors.reset}\n`);

  if (options) {
    console.log(`${colors.bright}快捷升级选项:${colors.reset}`);
    console.log(`  ${colors.green}1) patch${colors.reset} -> ${colors.cyan}${options.patch}${colors.reset}`);
    console.log(`  ${colors.green}2) minor${colors.reset} -> ${colors.cyan}${options.minor}${colors.reset}`);
    console.log(`  ${colors.green}3) major${colors.reset} -> ${colors.cyan}${options.major}${colors.reset}`);
    console.log(`  ${colors.gray}或直接输入具体版本号 (如 3.3.0, 3.4.0-beta.1)${colors.reset}\n`);
  }

  const input = await askQuestion(`${colors.bright}请输入目标版本号或选项 (1/2/3): ${colors.reset}`);
  if (!input) {
    console.log(`${colors.gray}操作已取消${colors.reset}`);
    process.exit(0);
  }

  if (options) {
    if (input === '1' || input.toLowerCase() === 'patch') return options.patch;
    if (input === '2' || input.toLowerCase() === 'minor') return options.minor;
    if (input === '3' || input.toLowerCase() === 'major') return options.major;
  }

  if (parseSemver(input)) return input;

  console.error(`\n${colors.red}❌ 无效的版本号格式: "${input}"${colors.reset}`);
  process.exit(1);
}

function updateFiles(currentVersion, newVersion) {
  const updatedFiles = [];

  // 1. 更新 package.json (精确替换 version 字段，保留原有排版格式)
  if (fs.existsSync(packageJsonPath)) {
    let pkgContent = fs.readFileSync(packageJsonPath, 'utf8');
    const pkgVersionPattern = /("version"\s*:\s*)"([^"]+)"/;
    if (pkgVersionPattern.test(pkgContent)) {
      pkgContent = pkgContent.replace(pkgVersionPattern, `$1"${newVersion}"`);
      fs.writeFileSync(packageJsonPath, pkgContent, 'utf8');
      updatedFiles.push('package.json');
    }
  }

  // 2. 更新 package-lock.json (精确替换前两个顶层与自身 package 的 version 字段)
  if (fs.existsSync(packageLockJsonPath)) {
    let lockContent = fs.readFileSync(packageLockJsonPath, 'utf8');
    // 替换顶层 "version": "..."
    let replacedCount = 0;
    lockContent = lockContent.replace(/("version"\s*:\s*)"([^"]+)"/g, (match, prefix, oldVer) => {
      // 仅替换前 2 个 version 出现位置（即顶层 version 和 packages[""].version）
      if (replacedCount < 2 && oldVer === currentVersion) {
        replacedCount++;
        return `${prefix}"${newVersion}"`;
      }
      return match;
    });
    fs.writeFileSync(packageLockJsonPath, lockContent, 'utf8');
    updatedFiles.push('package-lock.json');
  }

  // 3. 更新 README.md (替换所有 versiondock-x.y.z.vsix)
  if (fs.existsSync(readmePath)) {
    let readme = fs.readFileSync(readmePath, 'utf8');
    const vsixPattern = /versiondock-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.vsix/g;
    if (vsixPattern.test(readme)) {
      readme = readme.replace(vsixPattern, `versiondock-${newVersion}.vsix`);
      fs.writeFileSync(readmePath, readme, 'utf8');
      updatedFiles.push('README.md');
    }
  }

  return updatedFiles;
}

async function main() {
  if (!fs.existsSync(packageJsonPath)) {
    console.error(`${colors.red}❌ 未找到 package.json 文件${colors.reset}`);
    process.exit(1);
  }

  const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const currentVersion = pkgJson.version;

  const newVersion = await resolveTargetVersion(currentVersion);

  if (newVersion === currentVersion) {
    console.log(`\n${colors.yellow}⚠️ 目标版本号 (${newVersion}) 与当前版本一致，无需修改。${colors.reset}`);
    return;
  }

  const updatedFiles = updateFiles(currentVersion, newVersion);

  console.log(`\n${colors.green}${colors.bright}✅ 版本更新成功！${colors.reset}`);
  console.log(`   ${colors.yellow}${currentVersion}${colors.reset} ➜ ${colors.green}${colors.bright}${newVersion}${colors.reset}\n`);

  console.log(`${colors.bright}已更新文件:${colors.reset}`);
  updatedFiles.forEach((file) => {
    console.log(`  ${colors.cyan}• ${file}${colors.reset}`);
  });

  console.log(`\n${colors.gray}接下来你可以运行:${colors.reset}`);
  console.log(`  ${colors.blue}npm run build${colors.reset}        ${colors.gray}# 验证编译${colors.reset}`);
  console.log(`  ${colors.blue}npm run package${colors.reset}      ${colors.gray}# 打包生成 .vsix 插件包${colors.reset}`);
  console.log(`  ${colors.blue}git commit -am "chore: bump version to ${newVersion}"${colors.reset}\n`);
}

main().catch((err) => {
  console.error(`${colors.red}❌ 执行失败: ${err.message}${colors.reset}`);
  process.exit(1);
});
