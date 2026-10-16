# PI — zeroicey 的 Pi 扩展合集

> 存放自己写的 [Pi](https://pi.dev) 扩展。每个 `packages/<name>/` 是一个**可独立安装、可独立发布**的 Pi 包。

## 包含什么

| 包 | 一句话 | 状态 |
| --- | --- | --- |
| [`pi-unstall`](packages/pi-unstall/) | 对话被**异常中断**（供应商报错 / 被截断 / 模型话说一半就停）时，自动发一句 `continue` 让它继续 | 0.1.0，本地已用 |

## 目录约定

```
PI/
├── package.json          # workspace 根（private），只管开发
├── tsconfig.base.json    # 各包 tsconfig 的公共部分
└── packages/
    └── pi-unstall/       # 一个完整的 Pi 包：package.json + src/ + test/ + README
```

每个包自带 `package.json`（含 `pi` manifest、`keywords: ["pi-package"]`、
peerDependencies 指向宿主提供的 `@earendil-works/pi-*`）。**依赖别写进
`dependencies`** —— 宿主会提供，写进去会绕过 Pi 的模块映射、产生重复实例。

## 开发

```bash
bun install     # 装 devDependencies（typecheck 需要）
bun test        # 跑所有包的测试
```

## 安装某个包

```bash
pi install /data/dev/PI/packages/pi-unstall   # 本地路径（开发用）
pi install npm:pi-unstall                     # 发布后（npm）
pi install git:github.com/zeroicey/PI         # 或用 git（需指定子目录时用 pi 的 package 声明）
```

装完在 Pi 里 `/reload`。

## 发布纪律

1. 改包内 `package.json` 的 `version`。
2. `bun test` 全绿 + `npm pack --dry-run` 检查产物（`files` 白名单，别漏 `src`）。
3. `npm login` 后 `npm publish`（`publishConfig.access = public`）。
4. 打 tag：`git tag pi-unstall@0.1.0 && git push --tags`。
