# FTP Man

100대 이상의 FTP / FTPS / SFTP 서버와 인증정보를 맥에서 관리하고, **MCP(Model Context Protocol)** 로 AI 에이전트(Claude Code, Claude Desktop 등)에 파일 작업 도구만 노출하는 macOS 앱입니다.

- 인증정보는 macOS Keychain 기반 `safeStorage`로 암호화되어 로컬 파일에만 저장됩니다. 어떤 MCP 도구도 비밀번호·개인키를 반환하지 않습니다.
- MCP 엔드포인트는 `127.0.0.1` 전용이며 Bearer 토큰으로 보호됩니다.
- 여러 서버에 같은 작업을 순차적으로 실행하는 `batch` 도구가 있습니다 (태그 또는 서버 목록으로 선택, 서버별 실패 격리).
- 쓰기·삭제 작업은 앱에서 사람이 승인해야 실행되도록 설정할 수 있고, 모든 에이전트 활동이 기록됩니다.

**다운로드:** https://ftp-man.pages.dev (Apple silicon · Intel, Developer ID 서명 + Apple 공증)

## 실행

```bash
pnpm install
pnpm dev        # 개발 모드 (핫 리로드)
pnpm test       # 단위·통합 테스트 (node:test, 인메모리 가짜 서버로 MCP 도구까지 검증)
tests/e2e/run.sh  # 실제 FTP 서버 2대(pyftpdlib)를 띄워 빌드된 앱에 MCP 호출을 날리는 E2E (사전: pnpm build, .venv에 pyftpdlib)
pnpm build      # out/ 에 번들 생성
pnpm package    # release/ 에 서명·공증된 .dmg/.zip 생성 (arm64 + x64)
pnpm package:unsigned  # 서명 없이 앱 번들만 (로컬 확인용)
```

`pnpm package` 는 Keychain의 "Developer ID Application" 인증서로 서명하고, 아래 환경변수가 있으면 Apple 공증까지 수행합니다.

```bash
export APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=<App Store Connect issuer id>
```

배포물은 Cloudflare R2 버킷 `ftp-man-releases` 에 올리고(`wrangler r2 object put ... --remote`), 소개 페이지는 `site/` 를 Cloudflare Pages 프로젝트 `ftp-man` 에 배포합니다.

```bash
CLOUDFLARE_ACCOUNT_ID=<Lightsoft account id> wrangler pages deploy site --project-name ftp-man --branch main
```

UI는 한국어·영어를 지원하며 기본은 시스템 언어를 따릅니다(설정 → 언어).

앱 창을 닫아도 Dock에 남아 MCP 요청을 계속 처리합니다. 완전히 종료하려면 Cmd+Q.

## 서버 등록

앱에서 직접 추가하거나 **CSV 가져오기**로 한 번에 등록합니다. 헤더 행이 필요하며 열 순서는 자유입니다.

```csv
name,host,port,protocol,username,password,tags,notes,root_path,private_key_path,passphrase,insecure_tls
client-a 운영,ftp.client-a.com,21,ftps,deploy,S3cret!,client-a;wordpress,,/public_html,,,true
client-b,sftp.client-b.io,,sftp,ubuntu,,client-b;wordpress,,/var/www/html,~/.ssh/id_ed25519,,
```

| 열 | 설명 |
| --- | --- |
| `name` | 고유 이름. MCP 도구에서 id 대신 사용할 수 있습니다. 같은 이름이 있으면 갱신됩니다. |
| `protocol` | `ftp`, `ftps`(명시적 TLS), `sftp`. 기본 `ftp`. |
| `port` | 비우면 프로토콜 기본값(21/22). |
| `password` | 비우면 기존 비밀번호를 유지합니다. |
| `tags` | `;`, `,`, `\|` 로 구분. 배치 작업의 선택 기준입니다. |
| `root_path` | 상대 경로의 기준 디렉터리. 비우면 로그인 디렉터리. |
| `private_key_path` | SFTP 개인키 파일 경로. 있으면 키 인증으로 저장됩니다. |
| `insecure_tls` | FTPS에서 자체 서명 인증서 허용 (`true`). |

내보내기는 비밀번호를 제외합니다.

스크립트로 대량 등록하려면 실행 인자로 CSV를 넘길 수 있습니다 (앱이 뜨면서 가져오기가 실행되고 stdout에 결과가 찍힙니다).

```bash
open -a "FTP Man" --args --import-csv=/path/servers.csv      # 설치된 앱
node_modules/.bin/electron out/main/index.js --import-csv=/path/servers.csv   # 개발 빌드
```

## 에이전트 연결

앱의 **설정** 탭에 복사용 명령이 준비되어 있습니다.

**Claude Code** (HTTP 전송 직접 연결)

```bash
claude mcp add --transport http ftp-man http://127.0.0.1:7391/mcp \
  --header "Authorization: Bearer <토큰>"
```

**Claude Desktop 등 stdio 클라이언트** (동봉된 브리지 사용, 의존성 없음)

```json
{
  "mcpServers": {
    "ftp-man": { "command": "node", "args": ["/Applications/FTP Man.app/Contents/Resources/bridge/ftp-man-mcp.mjs"] }
  }
}
```

브리지는 `~/Library/Application Support/ftp-man/mcp-token` 과 `settings.json` 을 읽어 앱에 접속합니다. 환경변수 `FTP_MAN_URL`, `FTP_MAN_TOKEN`, `FTP_MAN_DIR` 로 덮어쓸 수 있습니다.

## MCP 도구

서버는 `id` 또는 정확한 `name` 으로 지정합니다. 경로는 절대 경로 또는 서버 기본 디렉터리 기준 상대 경로입니다.

| 도구 | 종류 | 설명 |
| --- | --- | --- |
| `list_servers` | 읽기 | 서버 목록 (`tag`, `query` 필터). 인증정보 없음. |
| `test_connection` | 읽기 | 접속 확인, 기본 디렉터리·지연시간 반환. |
| `list_files` | 읽기 | 디렉터리 목록. |
| `get_file_info` | 읽기 | 파일/디렉터리 정보. |
| `read_file` | 읽기 | 파일 내용 (utf8 또는 base64, 크기 제한). |
| `find_files` | 읽기 | 글롭/부분 문자열로 재귀 검색. |
| `download_file` | 읽기 | 로컬 경로로 다운로드. |
| `write_file` | 쓰기 | 텍스트로 파일 생성/덮어쓰기. |
| `upload_file` | 쓰기 | 로컬 파일 업로드. |
| `delete_path` | 쓰기 | 파일/디렉터리 삭제 (`recursive`). |
| `make_directory` | 쓰기 | 디렉터리 생성 (상위 포함). |
| `rename_path` | 쓰기 | 이름 변경/이동. |
| `batch` | 혼합 | 위 작업 하나를 여러 서버에 실행. `tag` 또는 `servers`, `concurrency`(기본 1), `stop_on_error`. |

### 예시 프롬프트

> `wordpress` 태그가 붙은 서버 전부에서 `wp-config.php` 를 읽어서 `WP_DEBUG` 가 켜진 곳을 알려줘.

에이전트는 `batch { tag: "wordpress", operation: { type: "read_file", path: "wp-config.php" } }` 를 한 번 호출하고 서버별 결과를 받습니다.

> `client-a`, `client-b` 서버의 `robots.txt` 를 이 내용으로 바꿔줘.

`batch { servers: ["client-a", "client-b"], operation: { type: "write_file", path: "robots.txt", content: "..." } }` → 앱에서 승인 → 서버별 성공/실패 반환.

배치 다운로드는 `local_path` 에 `{server}` 를 넣어 서버별로 구분합니다 (`~/backup/{server}/.htaccess`).

## 안전장치

- **승인 정책** (설정): `쓰기·삭제만 승인`(기본) / `모두 승인` / `승인 없음`. 승인 요청은 5분 후 자동 거부됩니다. 배치는 한 번의 승인으로 전체가 실행됩니다.
- **읽기 전용 모드**: 모든 쓰기 도구를 즉시 거부합니다.
- **활동 로그**: 앱의 활동 탭과 `activity.jsonl` 에 도구·서버·내용·결과·소요시간이 기록됩니다.
- **연결 풀**: 서버당 연결 하나를 재사용하고 같은 서버의 작업은 직렬화됩니다. 오류가 나면 연결을 버리고 다음 호출에서 재접속합니다.

## 저장 위치

`~/Library/Application Support/ftp-man/`

| 파일 | 내용 |
| --- | --- |
| `servers.json` | 서버 메타데이터 + `safeStorage` 로 암호화된 비밀 (0600) |
| `settings.json` | 포트, 승인 정책 등 |
| `mcp-token` | MCP 엔드포인트 Bearer 토큰 (0600) |
| `activity.jsonl` | 에이전트 활동 로그 |

## 구조

```
src/main/        Electron 메인 프로세스
  store/         서버·설정 저장소, CSV, 암호화 추상화
  remote/        RemoteClient 인터페이스, FTP(basic-ftp)·SFTP(ssh2) 어댑터, 연결 풀
  mcp/           MCP 도구 정의(tools.ts), 로컬 HTTP 전송(http.ts), 토큰
  approvals.ts   사용자 승인 브로커
  activity.ts    활동 로그
src/preload/     contextBridge API
src/renderer/    React UI
bin/             stdio ⇄ HTTP 브리지 (의존성 없음)
tests/           node:test 기반 저장소·MCP 통합 테스트, tests/e2e 실서버 E2E
site/            제품 소개 페이지 (Cloudflare Pages, 한/영)
build/           앱 아이콘(SVG 원본·icns), macOS entitlements
```
