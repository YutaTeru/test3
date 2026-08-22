# Novel Auto Publisher — Cloudflare Browser Run

Cloudflare Worker + Browser Run + Playwright で、小説投稿サイトへの投稿作業を自動化するための専用フォルダ。

## 現在の段階

Phase 1 の安全な土台のみ実装済み。

- `GET /health` — Worker稼働確認
- `GET /browser-check?site=kakuyomu` — Browser Runでカクヨムを開けるか確認
- `GET /browser-check?site=nola` — Browser RunでNolaノベルを開けるか確認
- `GET /screenshot?site=kakuyomu` — Browser Runが見ている画面をPNGで返す
- `GET /screenshot?site=nola` — 同上
- `/draft/*` と `/publish/*` は、ログイン状態の安全な保存が終わるまで意図的に無効化

## セットアップ

```bash
cd automation/cloudflare-publisher
npm install
npx wrangler login
npx wrangler deploy
```

Cloudflare公式のBrowser Run用Playwrightを使うため、`wrangler.jsonc` に以下を設定済み。

- `compatibility_flags: ["nodejs_compat"]`
- Browser binding: `BROWSER`

## 次の段階：ログイン状態をKVに保存

Cloudflare Browser RunはPlaywrightの `storageState` をWorkers KVに保存できる。Cookie・localStorage・IndexedDB等を保存し、毎回パスワードを入力せずログイン状態を再利用する。

予定：

1. KV namespace を作成
2. `wrangler.jsonc` に `SESSION_KV` binding を追加
3. カクヨム用 `storageState` を `session:kakuyomu` に保存
4. Nola用 `storageState` を `session:nola` に保存
5. 下書き作成ルートを実装
6. 実サイトで数回検証
7. その後だけ予約公開/自動公開を有効化

## 安全ルール

- パスワード、Cookie、storageState、API TokenをGitHubへコミットしない。
- CAPTCHA/MFA/ボット保護を回避するコードは作らない。
- 最初は「下書き保存」まで。公開操作は別フラグにする。
- 投稿頻度を過剰にしない。
- 投稿前の本文はGitHub側を正本とし、投稿履歴を残す。

## 将来のリクエスト形式（予定）

```json
{
  "site": "kakuyomu",
  "mode": "draft",
  "workId": "...",
  "episodeTitle": "第1話 ...",
  "body": "本文..."
}
```

Nolaも同じ共通形式を使い、サイト別Adapterに分岐する。
