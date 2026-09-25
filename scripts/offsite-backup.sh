#!/usr/bin/env bash
# 本番・MVPの最新バックアップを暗号化してオフサイト(Cloudflare R2)へ転送する(独立レビュー H-3)。
# systemd timer(deploy/systemd/mirai-web-cad-offsite-backup.timer)から実行される想定。
#
# - 転送前に age で暗号化する。ホストには公開鍵(受信者)だけを置き、復号鍵はオーナーが
#   ホスト外で保管する。平文のdumpはホスト外へ出さない。
# - 転送先は rclone のリモート。接続設定と資格情報は環境ファイルの RCLONE_CONFIG_<名前>_* で渡し、
#   コマンドライン引数やログへ出さない。
# - 転送は --ignore-existing で冪等にし、転送後にリモートのサイズが手元の暗号化ファイルと
#   一致することを確かめる。最新のdumpが古すぎる場合は転送せずに失敗する(古いものを
#   新しいバックアップとして扱わない)。
# - 保持期間はR2のライフサイクルルールで管理する(docs/deployment-local.md)。
set -euo pipefail

# OFFSITE_SOURCES: "バックアップディレクトリ:リモート上の接頭辞" を空白区切りで並べる。
: "${OFFSITE_SOURCES:?OFFSITE_SOURCES is required (e.g. /var/backups/mirai-web-cad/postgres:production)}"
: "${OFFSITE_REMOTE:?OFFSITE_REMOTE is required (e.g. r2:mirai-web-cad-backups)}"
: "${AGE_RECIPIENTS_FILE:?AGE_RECIPIENTS_FILE is required}"
max_age_hours="${MAX_BACKUP_AGE_HOURS:-36}"

if [[ ! -s "$AGE_RECIPIENTS_FILE" ]]; then
  echo "暗号化の受信者(公開鍵)ファイルがありません: $AGE_RECIPIENTS_FILE" >&2
  exit 2
fi
if grep -q "AGE-SECRET-KEY" "$AGE_RECIPIENTS_FILE"; then
  # 復号鍵をホストに置かない(ホストが侵害されても、オフサイトの複製を復号できないようにする)。
  echo "受信者ファイルに復号鍵が含まれています。公開鍵(age1...)だけを置いてください: $AGE_RECIPIENTS_FILE" >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077

status=0
for source in $OFFSITE_SOURCES; do
  dir="${source%%:*}"
  prefix="${source#*:}"
  latest="$dir/latest.dump"
  if [[ ! -e "$latest" ]]; then
    echo "[$prefix] 最新のバックアップがありません: $latest" >&2
    status=1
    continue
  fi
  dump="$(readlink -f "$latest")"
  name="$(basename "$dump")"
  manifest="$dump.manifest"
  if [[ ! -s "$dump" || ! -s "$manifest" ]]; then
    echo "[$prefix] バックアップまたはmanifestが空か存在しません: $name" >&2
    status=1
    continue
  fi
  age_hours=$(( ($(date +%s) - $(stat -c %Y "$dump")) / 3600 ))
  if (( age_hours > max_age_hours )); then
    echo "[$prefix] 最新のバックアップが${age_hours}時間前のもので古すぎます(上限${max_age_hours}時間): $name" >&2
    status=1
    continue
  fi

  encrypted="$work/$name.tar.age"
  tar -C "$(dirname "$dump")" -cf - "$name" "$name.manifest" | age -R "$AGE_RECIPIENTS_FILE" -o "$encrypted"
  target="$OFFSITE_REMOTE/$prefix/$name.tar.age"
  if ! rclone copyto --ignore-existing "$encrypted" "$target"; then
    echo "[$prefix] 転送に失敗しました: $target" >&2
    status=1
    continue
  fi
  # ageの出力長は平文の長さと受信者数だけで決まるため、既に転送済みの場合もサイズで照合できる。
  local_size="$(stat -c %s "$encrypted")"
  remote_size="$(rclone lsjson --stat "$target" 2>/dev/null | sed -n 's/.*"Size":\([0-9]*\).*/\1/p' | head -n 1)"
  if [[ "$remote_size" != "$local_size" ]]; then
    echo "[$prefix] 転送後のサイズが一致しません(手元 ${local_size} / リモート ${remote_size:-なし}): $target" >&2
    status=1
    continue
  fi
  echo "[$prefix] offsite ok: $target (${local_size} bytes)"
done

exit "$status"
