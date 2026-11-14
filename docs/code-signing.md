# Spcod 代码签名与安全分发指南（macOS Gatekeeper / Windows SmartScreen）

> 文档性质：项目文档，随仓库跟踪。  
> 编写日期：2026-11-13；2026-11-15 迁入 `docs/`（Apple 会员价当日复核为 $99/年）。  
> 项目基线：`v0.1.0-beta.37`（撰写时为 `beta.35`），`electron-builder 26.15.3`，GitHub Releases + NSIS/DMG/ZIP 分发。  
> 目标：让 macOS 下载安装后正常通过 Gatekeeper；让 Windows 用户尽可能不再看到 SmartScreen。  
> 重要边界：**不要试图“绕过”安全机制，应通过正式签名、平台审核和可信分发满足其要求。**  
> 时效提醒：价格、地区支持列表、Store 注册政策会变，采购前以第 11 节链接的官方页面为准。

---

## 1. 先给结论

### 1.1 推荐路线怎么选

| Windows 分发目标 | 推荐路径 | 官方效果边界 | 直接成本 |
|---|---|---|---|
| 必须尽量避免 Store 下载场景的 SmartScreen 信誉警告 | **Microsoft Store + MSIX** | **微软明确说明 Store 分发应用不受 SmartScreen 下载警告影响；不包括 GitHub EXE、运行时下载内容、Smart App Control 或企业策略拦截** | 新注册流程个人/公司均 **$0**；MSIX 由 Microsoft 签名；另有适配和认证工作量 |
| 继续通过 GitHub 直接下载 `Spcod-Setup-*.exe`，且身份地区符合要求 | **Azure Artifact Signing（原 Trusted Signing）Public Trust + Basic** | **不能。** 初期仍可能提示，需要积累发布者和文件哈希信誉 | **$9.99/月/账户**，即 **$119.88/年**；超额签名另计 |
| 继续直接下载，但 Artifact Signing 不支持所在国家/地区 | 传统公共 CA 的 OV/EV 代码签名证书 | **不能。** OV/EV 都可能提示；EV 已不再直接绕过 SmartScreen | CA 报价差异大，需询价；不要仅为 SmartScreen 购买 EV 溢价 |
| 企业内网/受管设备 | 企业证书、Intune、WDAC、可信内网分发 | 取决于企业策略 | 由企业 IT 评估，不是公开消费者分发方案 |

**本项目的建议：**

1. macOS 继续直接分发 DMG/ZIP，接入 **Developer ID Application + Hardened Runtime + Apple 公证**，这是标准且确定的技术路线。
2. 如果“Windows 从 Store 下载安装时不再出现 SmartScreen 下载信誉警告”是硬指标，优先评估 **Microsoft Store + MSIX**，不要指望买一张 EV 证书解决。
3. 如果必须保留 GitHub 直接下载 EXE，优先考虑 Artifact Signing Basic；但要接受早期版本仍可能出现 SmartScreen，不能向用户承诺“签完就消失”。
4. 如果开发者/公司只有中国大陆身份，先注意 Artifact Signing 的地区限制：其 Public Trust 组织身份支持列表不包含中国大陆，个人身份更是只支持美国或加拿大。此时优先选择 Store，或向传统 CA 询价。

### 1.2 最容易花冤枉钱的旧经验

以下说法已经不应作为采购依据：

- “买 EV 证书就能立即、永久绕过 SmartScreen。”  
  **错误。** 微软 2026-05 更新的官方文档明确写明：EV certificates no longer bypass SmartScreen；仅为避免 SmartScreen 而支付 EV 溢价不再合理。
- “只要签名，所有用户都不会再看到提示。”  
  **错误。** SmartScreen 同时看发布者/证书信誉和文件哈希信誉。新证书、新文件、每个新版本都可能需要继续积累信誉。
- “Artifact Signing 是微软产品，所以签完必然没有提示。”  
  **错误。** 同一官方文档仍明确写明其信誉随下载量和行为积累。
- “Microsoft Store 个人账号 $19、公司账号 $99。”  
  **对新注册流程已过时。** 微软 2026-10 更新的注册文档写明：通过 `storedeveloper.microsoft.com` 的新流程，个人和公司账号均无注册费。

> 来源冲突说明：部分 Electron 教程或旧 CA 宣传仍使用“EV/Artifact 必过 SmartScreen”的绝对表述。本文以微软平台所有者当前的 SmartScreen 官方文档为准，不以营销文案作为结论。

---

## 2. 当前项目存在什么问题

### 2.1 macOS 当前是 ad-hoc，不是 Developer ID 正式发布

当前配置：

- `apps/desktop/electron-builder.yml`：`mac.identity: null`、`hardenedRuntime: false`。
- `apps/desktop/build/afterPack.mjs`：对 `.app` 强制 `codesign --sign -`，即 ad-hoc 重签。
- `.github/workflows/release.yml`：`CSC_IDENTITY_AUTO_DISCOVERY: "false"`。

这只解决包内容密封不一致导致的“已损坏”，**不等于 Apple 正式签名，也没有 Apple 公证票据**。接入正式签名时必须同步修改整条链路，不能只把证书塞进 CI。

### 2.2 Windows 当前 NSIS 没有公开受信任的发布者身份

用户看到蓝色 SmartScreen 框与 HTTP 404 是两件事：

- 404 是更新元数据/资产名问题，已通过 `beta.35` 修复。
- SmartScreen 是下载文件的发布者与文件哈希信誉问题，需要通过可信分发或签名及信誉积累解决。

### 2.3 当前 electron-builder 已具备所需配置口

已核对本仓库锁定版本源码：

- macOS：`identity`、`hardenedRuntime`、`notarize`；公证环境变量支持 App Store Connect API Key。
- Windows：`win.azureSignOptions`，可直接接 Artifact Signing；也支持 `signtoolOptions`。
- Artifact Signing 配置字段仍是 `azureSignOptions`，内部 PowerShell 模块仍出现 `TrustedSigning` 旧名称。服务现已更名 Artifact Signing，但不要自行把字段改成 `artifactSignOptions`。

---

## 3. 开始前统一准备

### 3.1 先决定发布者身份

先决定未来长期使用的发布者：

- 个人：Apple 和 Microsoft 可能显示个人法定姓名。
- 公司：显示公司法定实体名称，更适合长期产品和团队协作。

尽量让以下位置保持一致，避免用户看到不同名字，也避免更新签名校验复杂化：

- Apple Developer Program 主体。
- Microsoft Store / Artifact Signing 主体。
- 代码签名证书 Subject。
- NSIS“添加或删除程序”里的 Publisher。
- GitHub 项目主页、隐私政策、支持邮箱和域名。

**不要频繁更换证书主体。** Windows 更新签名校验和 SmartScreen 发布者信誉都受益于稳定身份。

### 3.2 材料清单

个人开发者：

- 法定姓名与身份证件。
- Apple Account 开启双重认证。
- Microsoft 个人账户；Store 新流程需要政府证件与自拍验证。
- 可接收外部邮件的邮箱。
- 若走 Artifact Signing 个人验证：目前只支持美国或加拿大，且 Azure 账单账户类型、法定姓名和地址必须满足官方要求。

公司/组织：

- 营业执照/注册文件、法定实体名称、注册地址。
- 有权代表公司签约的账号持有人。
- D-U-N-S Number：Apple 组织注册需要；Microsoft 公司验证推荐使用，也可按提示上传其他官方文件。
- 公司域名、域名邮箱、域名所有权证明。
- 主要和次要联系邮箱、支持邮箱。
- 如走 Artifact Signing：企业标识、官网、地址、代表人证件，且主体所在国家/地区必须在支持列表内。

发布材料：

- Spcod 中英文名称、简介、完整描述、功能列表。
- 现有图标及各尺寸 Store Logo。
- 至少一张截图，建议四张以上。
- 官网/下载页、支持联系方式、隐私政策 URL。
- 年龄分级问卷所需信息。
- 免费定价、目标市场、可见性和发布计划。
- 一台干净 macOS 测试机和一台干净 Windows 11 测试机/虚拟机。

### 3.3 时间预期

官方明确给出的时间：

- Artifact Signing 身份验证：**1–20 个工作日**，补材料时可能更久。
- Microsoft Store 公司注册若进入人工审核：通常 **2–5 个工作日**；使用文件而非 DUNS 时可能更长。
- SmartScreen 信誉：没有公开固定阈值，微软表示可能需要数周和来自广泛用户的数百次干净安装；不要把这当作承诺时间。

以下是项目管理估算，不是平台承诺：

- Apple 证书与 CI 接入：材料就绪后约 0.5–1 个工程日。
- Windows MSIX 适配与完整功能验证：至少预留 2–5 个工程日；本项目涉及子进程、任意项目目录读写和远程服务，不能只验证“能启动”。
- 首次 Store 提交流程：另预留填写材料、验证和退修时间。

---

## 4. macOS：Developer ID 签名与 Apple 公证

## 4.1 注册 Apple Developer Program

1. 打开 <https://developer.apple.com/programs/>。
2. 选择个人或组织并加入 Apple Developer Program。
3. 官方会员费为 **$99/年**，以注册页面显示的地区币种和税费为准。
4. 个人：使用法定姓名和开启双重认证的 Apple Account。
5. 组织：准备法定实体、签约权限和 D-U-N-S Number。组织注册要求见 <https://developer.apple.com/programs/enroll/>。

本用途不需要 Mac App Store 上架，也不需要 Developer ID Installer：

- DMG/ZIP 内的是 `.app`，使用 **Developer ID Application**。
- Apple 官方说明：Developer ID Application 用于签名 Mac app；公证票据使 Gatekeeper 能验证软件不是已知恶意软件且未被篡改。
- 公证服务按会员能力使用，本文不另列每次公证费用。

## 4.2 创建 Developer ID Application 证书

在持有私钥的 Mac 上：

1. 打开“钥匙串访问”。
2. 选择“证书助理” → “从证书颁发机构请求证书”。
3. 保存 CSR 文件。
4. 登录 Apple Developer → **Certificates, Identifiers & Profiles** → **Certificates** → 新建。
5. 选择 **Developer ID Application**，上传 CSR 并下载证书。
6. 双击安装到同一台 Mac 的登录钥匙串，确认证书与私钥配对存在。
7. 使用强密码导出 `.p12` 离线备份；不要把 `.p12`、私钥或密码提交到仓库。
8. 记录完整证书名称和 Team ID。

Apple 当前允许创建最多五张 Developer ID Application 证书。证书过期后，旧应用在证书有效时完成签名仍可按 Apple 规则运行；但续签新版本需要有效会员与新证书。

## 4.3 创建公证用 App Store Connect API Key

推荐 CI 使用 Team Key，而不是个人 Apple ID 密码：

1. 打开 App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API**。
2. 创建 **Team Key**，`@electron/notarize` 当前文档建议使用 **App Manager** 权限。
3. 记录：
   - Key ID。
   - Issuer ID。
   - `.p8` 私钥文件。私钥只能下载一次，需离线备份。
4. 将 `.p8` 内容做 Base64 后存入 GitHub Secret，runner 上再解码为文件。

本项目使用以下自定义 Secret 名称，不是要求 Apple 控制台显示同名：

| GitHub Secret | 内容 |
|---|---|
| `MAC_CERTIFICATE_P12_BASE64` | Developer ID `.p12` 的 Base64 |
| `MAC_CERTIFICATE_PASSWORD` | `.p12` 导出密码 |
| `APPLE_API_KEY_P8_BASE64` | App Store Connect `.p8` 的 Base64 |
| `APPLE_API_KEY_ID` | API Key ID |
| `APPLE_API_ISSUER` | API Issuer ID |

electron-builder 实际读取的是：

- `CSC_LINK`：runner 上的 `.p12` 路径。
- `CSC_KEY_PASSWORD`：`.p12` 密码。
- `APPLE_API_KEY`：runner 上的 `.p8` 路径。
- `APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。

## 4.4 修改本项目打包配置

建议在 `apps/desktop/electron-builder.yml` 做如下逻辑修改（这是操作指引，不代表本文已替你改代码）：

```diff
-# 仅为无证书 ad-hoc 构建保留 afterPack 钩子
-afterPack: "./build/afterPack.mjs"
+# 正式 Developer ID 构建删除 afterPack，或只在显式本地 ad-hoc 模式执行

 mac:
   category: public.app-category.developer-tools
-  identity: null
-  hardenedRuntime: false
+  # 删除 identity 行，让 electron-builder 使用 CSC_LINK/钥匙串中的正式身份
+  hardenedRuntime: true
+  notarize: true
```

注意：

- 不要保留 `identity: null`，它表示跳过签名。
- 不要给整个应用随意添加 `disable-library-validation`；先用 electron-builder 默认 Electron entitlements 验证。
- 当前 `afterPack.mjs` 是为无证书 ad-hoc 包设计的。正式签名时应删除，或用单独环境开关限制为本地无证书构建，避免正式签名前再次改写包签名。
- `notarize: true` 只打开集成；如果缺公证环境变量，构建器可能仅警告并跳过，所以 CI 必须再做显式验收。

## 4.5 修改 GitHub Actions

将当前共用的 Package 步骤按操作系统拆开，避免 macOS 与 Windows 使用同一套 `CSC_*` 环境变量。

macOS 步骤示例：

```yaml
- name: Prepare Apple signing credentials
  if: matrix.os == 'macos-15'
  env:
    MAC_CERTIFICATE_P12_BASE64: ${{ secrets.MAC_CERTIFICATE_P12_BASE64 }}
    APPLE_API_KEY_P8_BASE64: ${{ secrets.APPLE_API_KEY_P8_BASE64 }}
  run: |
    printf '%s' "$MAC_CERTIFICATE_P12_BASE64" | base64 --decode > "$RUNNER_TEMP/spcod-developer-id.p12"
    printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode > "$RUNNER_TEMP/AuthKey.p8"
    chmod 600 "$RUNNER_TEMP/spcod-developer-id.p12" "$RUNNER_TEMP/AuthKey.p8"
    echo "CSC_LINK=$RUNNER_TEMP/spcod-developer-id.p12" >> "$GITHUB_ENV"
    echo "APPLE_API_KEY=$RUNNER_TEMP/AuthKey.p8" >> "$GITHUB_ENV"

- name: Package macOS（正式签名与公证）
  if: matrix.os == 'macos-15'
  working-directory: apps/desktop
  env:
    CSC_KEY_PASSWORD: ${{ secrets.MAC_CERTIFICATE_PASSWORD }}
    APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
    APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
  run: pnpm exec electron-builder --mac --publish never

# 必须放在“上传安装包产物”之前：任何签名/公证检查失败都阻断 Release。
- name: Verify macOS signatures and notarization
  if: matrix.os == 'macos-15'
  working-directory: apps/desktop
  run: |
    for APP in release/mac-arm64/Spcod.app release/mac/Spcod.app; do
      codesign --verify --deep --strict --verbose=2 "$APP"
      spctl -a -vvv -t execute "$APP"
      xcrun stapler validate "$APP"
    done
```

同时：

- 删除 macOS 构建中的 `CSC_IDENTITY_AUTO_DISCOVERY: "false"`，或明确设为 `true`。
- 确认日志出现 Developer ID 签名与 `notarization successful`，不能只看到 `ad-hoc` 或 `skipped macOS notarization`。
- `.p12`、`.p8` 只写 runner 临时目录；job 结束后自然销毁，不上传为 artifact。

## 4.6 macOS 验收，必须覆盖“带隔离属性的下载副本”

在本机 `apps/desktop/` 下按实际架构替换路径：

```bash
APP="release/mac-arm64/Spcod.app"

codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP"
spctl -a -vvv -t execute "$APP"
xcrun stapler validate "$APP"
```

验收点：

- `codesign -dv` 显示 Developer ID Application 和预期 Team ID，而不是 `-` / ad-hoc。
- `spctl` 接受应用。
- `stapler validate` 成功，证明 `.app` 的公证票据已附加。electron-builder 当前集成对 `.app` 执行公证，**不要额外假设每个 DMG 都一定带有可单独验证的票据**。
- 从 GitHub Release 用浏览器重新下载 DMG 和 ZIP，在干净 Mac/新用户环境启动。直接从构建目录启动不算 Gatekeeper 实网验收。
- 检查“新建会话并运行一条命令”、`sandbox-exec`、开机启动、自动更新、远程配对/监听等功能。Hardened Runtime 下“能打开”不代表全部子进程能力都正常。

公证失败时，用 submission ID 拉取日志：

```bash
xcrun notarytool log <submission-id> \
  --key "$APPLE_API_KEY" \
  --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER"
```

---

## 5. Windows 路线 A：Microsoft Store + MSIX（优先消除 Store 下载信誉警告）

## 5.1 免费注册开发者账号

从微软指定的新入口开始，旧入口可能进入旧流程：

1. 打开 <https://storedeveloper.microsoft.com>。
2. 个人选择 **Individual developer**，公司选择 **Company account**。
3. 个人：使用个人 Microsoft Account，完成政府证件和自拍验证。
4. 公司：可用个人 MSA 或 Microsoft Entra 工作账号；准备 D-U-N-S 或官方公司文件、公司域名邮箱和联系人信息。
5. 新流程下个人和公司均为 **$0 注册费**。
6. 完成后进入 Partner Center 的 **Apps & Games**。

个人账号适合非商业、个人/业余项目；与业务、职业或公司经营相关的分发应按官方说明选择公司账号。个人账号不能直接改为公司账号，需要重新创建。

## 5.2 为什么必须优先 MSIX，而不是直接登记现有 NSIS

微软提供两种 Win32 Store 分发方式：

| 项目 | MSIX | 直接登记 EXE/MSI |
|---|---|---|
| 托管 | Microsoft 提供 | 发布者自行托管 |
| 代码签名 | **Microsoft 提供** | **发布者仍需自行购买受信任 CA 证书** |
| 自动更新 | Windows/Store 管理 | 应用自己管理 |
| S Mode | 支持 | 不支持 |
| Store 高级能力 | 完整 | 受限 |

因此：

- 想实现“用户从 Store 安装且不受 SmartScreen 下载警告”，优先 MSIX。
- 直接把当前 NSIS URL 登记为 unpackaged Win32 应用，仍需要 CA 签名和自行更新，并不是零证书成本方案。
- 微软 SmartScreen 官方文档明确推荐 Store，并说明 Store 分发应用由 Microsoft 证书覆盖，不受 SmartScreen 下载警告影响。

## 5.3 本项目 MSIX 适配步骤

1. 从现有 Windows 构建生成 MSIX：
   - 可用 Microsoft MSIX Packaging Tool 从现有安装器转换；或
   - 单独评估 electron-builder 的 `appx` 目标与 Partner Center identity/publisher 配置。
2. 不要简单把 `.exe` 改名成 `.msix`，也不要未经验证直接上架。
3. 使用 Windows App Certification Kit（WACK）做本地验证。
4. 在干净 Windows 11 上安装 MSIX，逐项验证本项目高风险能力：
   - 任意项目目录选择、读取和写入。
   - pi/agent-host 子进程启动和长期运行。
   - shell/PowerShell 命令执行及 `sandbox-runtime` 的 Windows 可执行组件。
   - `%USERPROFILE%\.spcode` 配置、会话、密钥和用量文件。
   - 开机启动、登录项、后台任务。
   - 局域网监听、relay/Tailscale、远程配对。
   - 自动更新、文件预览、外部浏览器跳转。
5. 若 MSIX 沙箱/路径虚拟化与产品能力冲突，记录具体失败点，再决定：
   - 调整声明/实现并继续 MSIX；或
   - 改用 unpackaged EXE 登记，但仍需购买 CA 证书并自行处理更新；或
   - 保留 GitHub 直签路线并接受早期 SmartScreen。

**这部分是工程适配，不是只交注册费就能完成。** 对当前 Agentic Code 工作台，完整功能验证比安装页面本身更重要。

## 5.4 提交 Store 审核

按 Partner Center 当前清单准备：

1. 保留应用名称并开始 submission。
2. Pricing and availability：选择免费、市场、公开受众和发布时间。
3. Properties：选择类别；若收集/传输个人信息，提供隐私政策 URL。
4. Age ratings：完成问卷。
5. Packages：上传 MSIX/AppX 包，完成包验证。
6. Store listings：填写描述，上传截图和 Store Logo。
7. Submission options：填写审核备注，说明账号、子进程、文件访问和远程功能的测试方式。
8. 提交认证，处理可能的退修。

参考官方提交清单：<https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission>。

## 5.5 更新策略必须单轨化

Store MSIX 使用 Windows/Store 更新机制：

- 为 Store 构建关闭或替换 GitHub `electron-updater`，避免 Store 与应用自己同时更新。
- GitHub 直发版若并存，应明确区分渠道和包身份，避免用户交叉覆盖安装。
- beta/稳定通道可利用 Store 包分发能力或不同产品条目重新设计，不沿用当前 tag 即发布的假设。

---

## 6. Windows 路线 B：Artifact Signing 直接签名 GitHub EXE

## 6.1 先检查身份地区与订阅资格

Public Trust 当前支持：

- 组织：美国、加拿大、欧盟、英国、澳大利亚、新西兰、日本、韩国、新加坡、瑞士、挪威、以色列。
- 个人开发者：仅美国或加拿大。

**中国大陆不在上述列表中。** 不要用虚假地址注册；应选择 Store 或传统 CA。

还需要：

- Microsoft Entra tenant ID。
- **付费 Azure 订阅**。免费、试用或受赞助订阅不受支持。
- 准备身份材料、域名邮箱和代表人信息。

Artifact Signing 账户创建即开始计费，且不按当月剩余天数按比例退款/计费，因此先准备好材料再创建资源。

## 6.2 创建资源和角色

1. Azure Portal → Subscription → Resource providers → 注册 `Microsoft.CodeSigning`。
2. 创建 Artifact Signing Account：
   - 选择支持的区域。
   - 选择 **Basic SKU** 即可。
3. 给自己分配 **Artifact Signing Identity Verifier**，提交身份验证。
4. 身份验证完成后创建 **Public Trust** Certificate Profile。
5. 给 CI 使用的 Service Principal 分配 **Artifact Signing Certificate Profile Signer**，权限尽量只限定到目标 Certificate Profile。
6. 记录账户名、Profile 名、区域 Endpoint、证书 Subject 预览。

官方角色说明：Identity Verifier 用于管理身份验证；Certificate Profile Signer 用于实际签名。

## 6.3 当前 electron-builder 配置示例

`apps/desktop/electron-builder.yml`：

```yaml
win:
  target:
    - target: nsis
      arch: [x64]
    - target: zip
      arch: [x64]
  azureSignOptions:
    publisherName: "与证书 Subject 预览完全一致的发布者名称"
    endpoint: "https://eus.codesigning.azure.net" # 示例：替换为实际资源区域
    certificateProfileName: "SpcodPublicTrust"       # 替换为实际 Profile 名
    codeSigningAccountName: "spcodesign"             # 替换为实际账户名
```

注意：

- `publisherName` 必须稳定并与证书匹配，不要自行缩写品牌名。
- Endpoint 必须与账户和 Profile 区域一致，否则常见 403/`SignerSign()` 失败。
- `azureSignOptions` 与 `signtoolOptions` 不要同时配置。
- electron-builder 会为标准 Windows 可执行文件与安装器执行签名；发布时仍需检查主程序、安装包、卸载器及随包原生 EXE 的日志，不要只验证一个文件。

Windows Package 步骤环境变量示例：

```yaml
- name: Package Windows（Artifact Signing）
  if: matrix.os == 'windows-latest'
  working-directory: apps/desktop
  env:
    AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
    AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
    AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
  run: pnpm exec electron-builder --win --publish never

# 同样放在“上传安装包产物”之前，Status 不是 Valid 就阻断发布。
- name: Verify Windows signatures
  if: matrix.os == 'windows-latest'
  working-directory: apps/desktop
  shell: powershell
  run: |
    $ErrorActionPreference = "Stop"
    $files = Get-ChildItem -Path "release/Spcod-Setup-*.exe", "release/win*-unpacked/Spcod.exe" -File
    if (@($files).Count -lt 2) { throw "未找到待验收的主程序或安装包" }
    foreach ($file in $files) {
      $signature = Get-AuthenticodeSignature $file.FullName
      if ($signature.Status -ne "Valid") { throw "$($file.FullName) 签名无效：$($signature.Status)" }
    }
```

这里使用当前 electron-builder 已验证支持的 EnvironmentCredential 方式。CI 身份只给目标 Profile 的 Signer 权限；Secret 定期轮换，不写入日志或 Release。

## 6.4 价格与配额

| SKU | 月费 | 每月签名配额 | 超额 | Profile 配额 |
|---|---:|---:|---:|---|
| Basic | **$9.99/账户** | 5,000 次 | $0.005/次 | 每种类型 1 个 |
| Premium | $99.99/账户 | 100,000 次 | $0.005/次 | 每种类型 10 个 |

对 Spcod 当前发布频率，Basic 足够，没有必要为 SmartScreen 购买 Premium。

## 6.5 签名与 SmartScreen 验收

在 Windows 上：

```powershell
Get-AuthenticodeSignature .\Spcod-Setup-<版本>.exe | Format-List
signtool verify /pa /v .\Spcod-Setup-<版本>.exe
```

同时检查：

- Status 为 `Valid`，证书链指向公开受信任根。
- 发布者名称正确。
- 安装器包含可信时间戳。Artifact Signing 证书有效期很短，时间戳尤其重要。
- 主程序、安装器和卸载器都签名。
- 从 GitHub 用浏览器在干净 Windows 下载并安装，不能从本地构建目录复制测试，因为那样没有真实下载来源和 Mark-of-the-Web 场景。

**即使以上全部通过，也仍可能出现 SmartScreen。** 这是信誉机制，不是签名失败。新版本持续使用同一身份、避免修改已签名文件、保持正常下载与安装，才能逐步改善。

---

## 7. Windows 路线 C：传统 OV/EV 证书

适用情形：

- Artifact Signing 地区不支持。
- 不准备进入 Microsoft Store。
- 已有公司证书采购流程或云 HSM。

准备：

1. 从 Microsoft Trusted Root Program 中的公共 CA/正规渠道购买代码签名证书。
2. 完成组织身份审核，准备法定实体、地址、域名和代表人材料。
3. 确认交付方式：USB 硬件令牌、云 HSM/云签名，还是可安全用于 CI 的其他方式。
4. GitHub hosted runner 不能直接使用插在本地电脑上的 USB token；采购前必须确认 CI 集成。
5. 保留时间戳服务，签名后不要再修改二进制。

electron-builder 可使用：

```yaml
win:
  signtoolOptions:
    certificateSubjectName: "与证书完全一致的 Subject"
    signingHashAlgorithms: [sha256]
    rfc3161TimeStampServer: "http://timestamp.digicert.com"
```

也可用 `CSC_LINK` / `CSC_KEY_PASSWORD` 指向安全交付的 PFX，或使用供应商云签名自定义命令。`signtoolOptions` 与 `azureSignOptions` 二选一。

**EV 采购提醒：** 微软当前明确说明 EV 已不再直接绕过 SmartScreen。OV/EV 的有效签名都能显示已验证发布者并积累信誉，但初期都可能警告。不要仅为 SmartScreen 购买 EV；若因企业采购、合规或其他签名场景确需 EV，再单独评估。

价格没有统一官方定价，不同 CA、销售渠道、验证等级、年限和云 HSM 差异很大。本文只建议把传统 CA 作为询价项，不把任何第三方“包过 SmartScreen”的承诺写入预算。

---

## 8. 年度预算汇总

人民币仅按 **1 美元≈7.2 元**做预算换算，不是实时汇率或报价；税费、地区定价另计。

| 路线 | Apple | Windows | 年度直接费用估算 | 效果边界 |
|---|---:|---:|---:|---|
| **macOS 直发 + Windows Store MSIX** | $99/年 | 新注册 $0；MSIX 由 Microsoft 签名 | **约 $99/年，约 ¥710/年** | macOS 走标准签名公证；Store 安装不受 SmartScreen 下载警告；另有 MSIX 适配工作量 |
| **macOS 直发 + GitHub Artifact Basic** | $99/年 | $119.88/年 | **$218.88/年，约 ¥1,580/年** | 正规双平台签名；Windows 早期仍可能 SmartScreen |
| macOS 直发 + Artifact Premium | $99/年 | $1,199.88/年 | $1,298.88/年，约 ¥9,350/年 | 仅增加配额，不会额外解决 SmartScreen；本项目不推荐 |
| macOS 直发 + 传统 CA | $99/年 | 向 CA 询价 | Apple 费用 + CA 费用；建议先按 **¥3,000–10,000+ /年总预算**询价比较 | OV/EV 都可能仍需信誉积累；EV 不保证绕过，预算区间仅为非官方采购预留 |

可能另计：

- 域名、企业邮箱和隐私政策托管；已有则新增成本可为 0。
- D-U-N-S 本身通常可按官方流程申请，不把代理代办费视为平台必收费用。
- USB token 邮寄、云 HSM、CA 增值服务。
- Windows/macOS 干净测试设备或 CI runner。
- MSIX 适配、Store 审核退修和长期维护的工程人力。
- 保留 GitHub 直发渠道时的签名费用；选择 Store 并不会让 GitHub 上的未签名 EXE 自动变得可信。

**预算建议：**

- 若 Windows 的硬指标是“消除 Store 下载场景的 SmartScreen 信誉警告”：先按 **Apple $99/年 + Store $0** 做平台预算，把主要精力放在 MSIX 兼容性。
- 若必须继续 GitHub 直发且身份地区合格：按 **约 ¥1,600/年**准备双平台签名预算，并接受早期仍可能有提示。
- 若只有中国大陆身份且能改分发渠道：优先 Store；若必须坚持 GitHub 直发：向多家 CA 询价，不要按“EV 必过”的旧销售话术采购。

---

## 9. 推荐执行顺序

### 阶段一：账号和材料

- [ ] 确定个人或公司发布者，保持长期一致。
- [ ] 注册 Apple Developer Program，准备 Developer ID Application。
- [ ] 决定 Windows 走 Store MSIX 还是 GitHub 直签。
- [ ] Store：从指定新入口注册并准备描述、Logo、截图、隐私政策。
- [ ] Artifact：先核对国家/地区和付费订阅资格，再创建资源并提交身份验证。
- [ ] 准备干净 macOS/Windows 验收环境。

### 阶段二：macOS 接入

- [ ] 移除 `identity: null` 和正式构建的 ad-hoc 回退。
- [ ] 开启 Hardened Runtime 和 notarize。
- [ ] 在 GitHub Secrets 配置证书与 API Key。
- [ ] 拆分 macOS Package 步骤，不再禁用正式身份发现。
- [ ] 用 codesign/spctl/stapler 和真实浏览器下载验收。
- [ ] 验证子进程、沙盒、登录项和自动更新。

### 阶段三 A：Windows Store

- [ ] 生成 MSIX 并通过 WACK。
- [ ] 完整验证任意目录、子进程、远程服务、后台行为和用户数据路径。
- [ ] 为 Store 构建调整自动更新为单轨。
- [ ] 提交 Partner Center 审核并处理退修。
- [ ] 在干净 Windows 从 Store 安装，确认无 SmartScreen 下载警告。

### 阶段三 B：GitHub 直签

- [ ] 完成 Artifact Public Trust 或传统 CA 证书。
- [ ] 配置 `azureSignOptions` 或 `signtoolOptions`，不要同时存在。
- [ ] 签名主程序、安装器、卸载器和相关原生可执行文件。
- [ ] 验证 Authenticode 与可信时间戳。
- [ ] 真实下载测试，记录 SmartScreen 表现；不要将其承诺为永久消失。
- [ ] 保持证书身份稳定，持续发布，避免任何刷下载量行为。

---

## 10. 长期维护与安全要求

- 私钥、`.p12`、`.p8`、Service Principal Secret 不进入 Git，不出现在构建日志、公告或 artifact 中。
- 离线备份 Developer ID 私钥和密码；丢失后不仅影响签名，也增加身份连续性成本。
- 给 CI 最小权限，只授予目标 Certificate Profile 的 Signer；定期轮换 Secret。
- 所有签名都带可信时间戳；证书/账号到期前设置续期提醒。
- 每次 Release 同时验证签名、自动更新和安装包哈希，不允许先签名再改文件。
- beta 与稳定版尽量使用同一发布者身份，避免每次换证导致信誉和更新校验重新适应。
- 如果已正确签名仍被误报，可通过 Microsoft Security Intelligence 提交文件审查；消费者端没有“手工申请立即获得 SmartScreen 信誉”的公开渠道。
- 不购买“刷下载量”“ guaranteed SmartScreen removal”服务，不伪装企业地址，不让用户全局关闭 SmartScreen。
- 企业设备可能由策略禁止“仍要运行”，个人电脑通过测试不代表企业环境也能绕过。

### 首次签名身份迁移与连续更新验收

首个正式签名版本发布后，不能只验证新安装：

- 保留最后一个 ad-hoc/未签名版本（撰写时为 `beta.35`）的 macOS 包和 Windows 未签名包作为旧版起点。
- 先测试 `未签名旧版 → 首个正式签名版本`。macOS 旧 ad-hoc 版若无法完成自动更新，应明确提供一次手动覆盖安装指引，不宣称旧版一定能无感迁移。
- 再测试 `首个正式签名版本 → 下一个同身份签名版本`，这一轮必须直接自动更新，不卸载。
- macOS 同时覆盖 DMG 新安装与 ZIP 自动更新；Windows 覆盖 NSIS 自动更新、卸载器签名和 `publisherName` 校验。
- 如果更新失败，保持旧版可回退，不要通过换证书主体或关闭更新签名校验掩盖问题。

---

## 11. 官方来源（2026-11-13 核对）

### Apple

- Apple Developer Program，$99 年费与个人/组织入口：  
  <https://developer.apple.com/programs/>
- 组织注册、法定实体和 D-U-N-S：  
  <https://developer.apple.com/programs/enroll/>
- Developer ID 与 Gatekeeper/公证作用：  
  <https://developer.apple.com/support/developer-id/>
- Apple 公证总览：  
  <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>
- Electron 官方签名与公证说明：  
  <https://www.electronjs.org/docs/latest/tutorial/code-signing>
- `@electron/notarize` 当前 Team Key、App Manager、`.p8` 路径说明：  
  本仓库依赖 `@electron/notarize@2.5.0` 的 `README.md` 与 `lib/types.d.ts`。

### Microsoft SmartScreen 与 Store

- SmartScreen 信誉机制、OV/EV 仍可能警告、EV 不再绕过、Store 推荐：  
  <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation>
- 新开发者注册流程，个人/公司均免费：  
  <https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/account-types-locations-and-fees>
- Win32 的 MSIX 与 unpackaged EXE/MSI 对比：  
  <https://learn.microsoft.com/en-us/windows/apps/distribute-through-store/how-to-distribute-your-win32-app-through-microsoft-store>
- MSIX 提交清单：  
  <https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission>
- EXE/MSI 的静默安装、卸载条目与 bundleware 本地验证：  
  <https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/manual-package-validation>

### Azure Artifact Signing

- 服务与资源结构：  
  <https://learn.microsoft.com/en-us/azure/artifact-signing/overview>
- 地区限制、付费订阅、账户/身份/Profile 创建，1–20 工作日：  
  <https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart>
- Basic/Premium 价格与配额：  
  <https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku>
- Azure 价格页：  
  <https://azure.microsoft.com/en-us/pricing/details/artifact-signing/>
- Public Trust 与 SmartScreen/Smart App Control：  
  <https://learn.microsoft.com/en-us/azure/artifact-signing/concept-trust-models>
- Identity Verifier / Certificate Profile Signer：  
  <https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles>
- SignTool、GitHub Actions、时间戳与集成：  
  <https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations>
- FAQ：短有效期证书、EV 不提供、SmartScreen 信誉、计费和故障排查：  
  <https://learn.microsoft.com/en-us/azure/artifact-signing/faq>

### 本项目源码依据

- `apps/desktop/electron-builder.yml`
- `apps/desktop/build/afterPack.mjs`
- `.github/workflows/release.yml`
- `app-builder-lib@26.15.3`：`out/options/macOptions.d.ts`、`out/options/winOptions.d.ts`、`out/mac/MacTargetHelper.js`、`out/codeSign/windowsSignAzureManager.js`

---

## 12. 最终建议（给当前项目的采购决定）

1. **立即可做且最确定的是 macOS：**购买/续期 Apple Developer Program，完成 Developer ID + 公证，不再使用 ad-hoc 作为正式 Release。
2. **Windows 若要求消除 Store 下载场景的 SmartScreen 信誉警告：**先不要买 EV。注册免费 Microsoft Store 开发者账号，做一轮 MSIX 技术验证；通过后再提交审核。
3. **若 MSIX 与 Agent 能力冲突：**保留 GitHub NSIS，按地区选择 Artifact Basic 或传统 CA，并把“早期可能仍有提示”写进发布说明和用户指引。
4. **任何路线都不建议仅为 SmartScreen 购买 EV 溢价。**这是当前微软官方规则下最明确的成本控制点。
