# 历史安装终端记录

> 原始会话归档，仅用于追溯旧环境问题；当前安装方式以根目录 README 为准。

j-liutong3-jk@pboc-risk-yushu-dev01:~/convert/test$ export NVM_NODEJS_ORG_MIRROR=https://unofficial-builds.nodejs.org/download/release
j-liutong3-jk@pboc-risk-yushu-dev01:~/convert/test$ nvm install 20.20.1   # 本项目 pdf-parse 要求 Node >=20.16.0
bash: nvm: command not found
j-liutong3-jk@pboc-risk-yushu-dev01:~/convert/test$ nvm use 20.20.1
bash: nvm: command not found
j-liutong3-jk@pboc-risk-yushu-dev01:~/convert/test$ node -v                # 正常打印版本号，不报 GLIBC 错误 即可
v16.20.2
j-liutong3-jk@pboc-risk-yushu-dev01:~/convert/test$ nvm install 20.20.1
bash: nvm: command not found
j-liutong3-jk@pboc-risk-yushu-dev01:~/convert/test$ cd ..
j-liutong3-jk@pboc-risk-yushu-dev01:~/convert$ cd ..
j-liutong3-jk@pboc-risk-yushu-dev01:~$ cd agent/
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ls
Archive.zip  __MACOSX      node-v20.20.1-linux-x64-glibc-217.tar.xz  package.json       README.md  src
dist         node_modules  note.md                                   package-lock.json  scripts
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm install
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'ansi-escapes@7.3.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'cli-truncate@4.0.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'environment@1.1.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'esbuild@0.24.2',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'get-east-asian-width@1.6.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'ink@5.2.1',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'is-in-ci@1.0.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'pdf-parse@2.4.5',
npm WARN EBADENGINE   required: { node: '>=20.16.0 <21 || >=22.3.0' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'pdfjs-dist@5.4.296',
npm WARN EBADENGINE   required: { node: '>=20.16.0 || >=22.3.0' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'slice-ansi@7.1.2',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'is-fullwidth-code-point@5.1.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'string-width@7.2.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'tsx@4.22.4',
npm WARN EBADENGINE   required: { node: '>=18.0.0' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'esbuild@0.28.1',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'widest-line@5.0.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'wrap-ansi@9.0.2',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
(##################) ⠋ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and
(##################) ⠋ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and
^[(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/an^[(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/an^[(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/an^[(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/an^[(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/an^[(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/an^[(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/an^[(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/an(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and
(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and
(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and
(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and
(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and
(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and

(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and
(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and
(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and
(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and
(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/and
^C(##################) ⠦ reify:@esbuild/aix-ppc64: timing reifyNode:node_modules/tsx/node_modules/@esbuild/an

j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm ci --omit=dev
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'ansi-escapes@7.3.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'cli-truncate@4.0.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'environment@1.1.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'esbuild@0.24.2',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'get-east-asian-width@1.6.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'ink@5.2.1',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'is-in-ci@1.0.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'pdf-parse@2.4.5',
npm WARN EBADENGINE   required: { node: '>=20.16.0 <21 || >=22.3.0' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'pdfjs-dist@5.4.296',
npm WARN EBADENGINE   required: { node: '>=20.16.0 || >=22.3.0' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'slice-ansi@7.1.2',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'is-fullwidth-code-point@5.1.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'string-width@7.2.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'tsx@4.22.4',
npm WARN EBADENGINE   required: { node: '>=18.0.0' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'esbuild@0.28.1',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'widest-line@5.0.0',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
npm WARN EBADENGINE Unsupported engine {
npm WARN EBADENGINE   package: 'wrap-ansi@9.0.2',
npm WARN EBADENGINE   required: { node: '>=18' },
npm WARN EBADENGINE   current: { node: 'v16.20.2', npm: '8.19.4' }
npm WARN EBADENGINE }
^C(##########⠂⠂⠂⠂⠂⠂⠂⠂) ⠴ reify:@napi-rs/canvas-android-arm64: timing reifyNode:node_modules/@napi-rs/canvas-d

j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ which node; which npm
/usr/bin/node
/usr/bin/npm
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ node -v      # if this prints v16.x, the export didn't take
v16.20.2
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ls -la $HOME/node20/bin/node          # does the extracted binary actually exist?
-rwxr-xr-x 1 j-liutong3-jk j-liutong3-jk 100935448 Mar  6 23:24 /data/oceanus_ctr/j-liutong3-jk/node20/bin/node
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ $HOME/node20/bin/node -v              # version when called directly, bypassing PATH
v20.20.1
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ echo $PATH                            # is $HOME/node20/bin even listed?
/data/oceanus_ctr/j-liutong3-jk/.local/bin:/root/miniconda3/bin:/command:/root/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/etc/alternatives/java_sdk:/usr/hdp/3.1.4.0-315/hadoop//bin:/usr/hdp/3.1.4.0-315/spark3.3.2//bin:/usr/hdp/3.1.4.0-315/hive//bin:/etc/alternatives/java_sdk
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ grep node20 ~/.bashrc                 # did the export line actually get saved?
export PATH=$HOME/node20/bin:$PATH
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$  source ~/.bashrc
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm ci --omit=dev
⠹^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm install
⠼^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$   curl -sI --max-time 10 https://registry.npmjs.org/ | head -5
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm config get registry
https://registry.npmjs.org/
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$  npm install --registry=https://registry.npmmirror.com
npm error code ENOTEMPTY
npm error syscall rename
npm error path /data/oceanus_ctr/j-liutong3-jk/agent/node_modules/cli-truncate
npm error dest /data/oceanus_ctr/j-liutong3-jk/agent/node_modules/.cli-truncate-YVJDPa9D
npm error errno -39
npm error ENOTEMPTY: directory not empty, rename '/data/oceanus_ctr/j-liutong3-jk/agent/node_modules/cli-truncate' -> '/data/oceanus_ctr/j-liutong3-jk/agent/node_modules/.cli-truncate-YVJDPa9D'
npm error A complete log of this run can be found in: /data/oceanus_ctr/j-liutong3-jk/.npm/_logs/2026-07-09T09_21_27_287Z-debug-0.log
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm install --registry=http://repo.geelib.qihoo.net:8360/nexus/repository/npm-mirrors-public/
npm error code ENOTEMPTY
npm error syscall rename
npm error path /data/oceanus_ctr/j-liutong3-jk/agent/node_modules/cli-truncate
npm error dest /data/oceanus_ctr/j-liutong3-jk/agent/node_modules/.cli-truncate-YVJDPa9D
npm error errno -39
npm error ENOTEMPTY: directory not empty, rename '/data/oceanus_ctr/j-liutong3-jk/agent/node_modules/cli-truncate' -> '/data/oceanus_ctr/j-liutong3-jk/agent/node_modules/.cli-truncate-YVJDPa9D'
npm error A complete log of this run can be found in: /data/oceanus_ctr/j-liutong3-jk/.npm/_logs/2026-07-09T09_37_00_248Z-debug-0.log
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm config set registry http://repo.geelib.qihoo.net:8360/nexus/repository/npm-mirrors-public/
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$  npm install
npm error code ENOTEMPTY
npm error syscall rename
npm error path /data/oceanus_ctr/j-liutong3-jk/agent/node_modules/cli-truncate
npm error dest /data/oceanus_ctr/j-liutong3-jk/agent/node_modules/.cli-truncate-YVJDPa9D
npm error errno -39
npm error ENOTEMPTY: directory not empty, rename '/data/oceanus_ctr/j-liutong3-jk/agent/node_modules/cli-truncate' -> '/data/oceanus_ctr/j-liutong3-jk/agent/node_modules/.cli-truncate-YVJDPa9D'
npm error A complete log of this run can be found in: /data/oceanus_ctr/j-liutong3-jk/.npm/_logs/2026-07-09T09_40_03_467Z-debug-0.log
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ls package.json
package.json
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ rm -rf node_modules
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm ci --omit=dev
⠴^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ cat ~/agent/package.json | head -20
{
  "name": "ai-cli",
  "version": "0.1.0",
  "description": "在终端输入 ai 弹出可编辑对话框，接入 DeepSeek",
  "type": "module",
  "bin": {
    "ai": "dist/cli.js"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "esbuild src/cli.tsx --bundle --platform=node --target=node20 --format=esm --packages=external --jsx=automatic --banner:js=\"#!/usr/bin/env node\" --outfile=dist/cli.js",
    "dev": "tsx src/cli.tsx",
    "start": "node dist/cli.js",
    "dmg": "bash scripts/make-dmg.sh",
    "pkg": "bash scripts/make-pkg.sh"
  },
  "dependencies": {
    "ink": "^5.1.0",
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ls -la ~/agent
total 468781
drwxrwxr-x  7 j-liutong3-jk j-liutong3-jk        11 Jul  9 17:41 .
drwxr-xr-x 48 j-liutong3-jk j-liutong3-jk       705 Jul  9 17:39 ..
-rw-r--r--  1 j-liutong3-jk j-liutong3-jk 453570963 Jul  9 15:02 Archive.zip
drwxr-xr-x  3 j-liutong3-jk j-liutong3-jk         6 Jul  9 16:22 dist
drwxrwxr-x  6 j-liutong3-jk j-liutong3-jk        12 Jul  9 15:03 __MACOSX
drwxrwxr-x 71 j-liutong3-jk j-liutong3-jk        69 Jul  9 17:41 node_modules
-rw-r--r--  1 j-liutong3-jk j-liutong3-jk  26350536 Jul  9 15:45 node-v20.20.1-linux-x64-glibc-217.tar.xz
-rw-r--r--  1 j-liutong3-jk j-liutong3-jk     16432 Jun 23 13:08 note.md
-rw-r--r--  1 j-liutong3-jk j-liutong3-jk       812 Jul  2 16:34 package.json
-rw-r--r--  1 j-liutong3-jk j-liutong3-jk     64417 Jul  2 16:34 package-lock.json
-rw-r--r--  1 j-liutong3-jk j-liutong3-jk     27247 Jul  2 21:43 README.md
drwxr-xr-x  2 j-liutong3-jk j-liutong3-jk         3 Jun 17 15:30 scripts
drwxr-xr-x  4 j-liutong3-jk j-liutong3-jk        16 Jul  2 22:35 src
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$  cat <<'EOF'
>   cd ~/agent
>   rm -rf node_modules __MACOSX dist
>   ls -la          # sanity check: node_modules/__MACOSX/dist gone, package.json/src/ still there
>   npm ci --omit=dev
>   EOF)
> run on dev01:
> cd ~/agent
> rm -rf node_modules __MACOSX dist
> ls -la          # sanity check: node_modules/__MACOSX/dist gone, package.json/src/ still there
> npm ci --omit=dev
>
>
> ^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$  rm -rf node_modules __MACOSX dist

j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$  ls -la
total 468781
drwxrwxr-x  4 j-liutong3-jk j-liutong3-jk         8 Jul  9 17:49 .
drwxr-xr-x 48 j-liutong3-jk j-liutong3-jk       705 Jul  9 17:39 ..
-rw-r--r--  1 j-liutong3-jk j-liutong3-jk 453570963 Jul  9 15:02 Archive.zip
-rw-r--r--  1 j-liutong3-jk j-liutong3-jk  26350536 Jul  9 15:45 node-v20.20.1-linux-x64-glibc-217.tar.xz
-rw-r--r--  1 j-liutong3-jk j-liutong3-jk     16432 Jun 23 13:08 note.md
-rw-r--r--  1 j-liutong3-jk j-liutong3-jk       812 Jul  2 16:34 package.json
-rw-r--r--  1 j-liutong3-jk j-liutong3-jk     64417 Jul  2 16:34 package-lock.json
-rw-r--r--  1 j-liutong3-jk j-liutong3-jk     27247 Jul  2 21:43 README.md
drwxr-xr-x  2 j-liutong3-jk j-liutong3-jk         3 Jun 17 15:30 scripts
drwxr-xr-x  4 j-liutong3-jk j-liutong3-jk        16 Jul  2 22:35 src
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm ci --omit=dev
⠙^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$  Bash(echo "run on dev01 — first Ctrl+C the stuck npm ci, then run these:"
bash: syntax error near unexpected token `echo'
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$   cat <<'EOF'
>   # 1. confirm the registry setting actually stuck
>   npm config get registry
>
>   # 2. any proxy config that could be interfering (internal mirror often needs NO proxy,
>   #    but a leftover corporate proxy var could break it, or vice versa)
>   npm config get proxy
>   npm config get https-proxy
>   env | grep -i proxy
>
>   # 3. test the mirror against a REAL package, not just the base URL (metadata fetch)
>   curl -sS --max-time 15 http://repo.geelib.qihoo.net:8360/nexus/repository/npm-mirrors-public/ink | head -c 300
>   echo
>
>   # 4. test fetching an actual tarball through it (this is what was probably hanging)
>   curl -sS --max-time 20 -o /dev/null -w "http_code=%{http_code} time_total=%{time_total}\n" \
>     http://repo.geelib.qihoo.net:8360/nexus/repository/npm-mirrors-public/ink/-/ink-5.1.0.tgz
>
>   # 5. re-run with verbose logging so we can see exactly which request it's stuck on;
>   #    let it run ~30s then Ctrl+C and paste the last ~30 lines
>   npm ci --omit=dev --loglevel=verbose 2>&1 | tee /tmp/npm-verbose.log
>   EOF)
>
> '
> >
>
> ?
>
> ^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm config get registry
http://repo.geelib.qihoo.net:8360/nexus/repository/npm-mirrors-public/
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm config get proxy
null
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm config get https-proxy
null
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ env | grep -i proxy
CLASSPATH=/usr/hdp/3.1.4.0-315/hadoop/conf:/usr/hdp/3.1.4.0-315/hadoop/lib/kerby-xdr-1.0.1.jar:/usr/hdp/3.1.4.0-315/hadoop/lib/jsch-0.1.54.jar:/usr/hdp/3.1.4.0-315/hadoop/lib/ranger-hdfs-plugin-shim-1.2.0.3.1.4.0-315.jar:/usr/hdp/3.1.4.0-315/hadoop/lib/jackson-xc-1.9.13.jar:/usr/hdp/3.1.4.0-315/hadoop/lib/ranger-plugin-classloader-1.2.0.3.1.4.0-315.jar:/usr/hdp/3.1.4.0-315/hadoop/lib/jetty-server-9.3.24.v20180605.jar:/usr/hdp/3.1.4.0-315/hadoop/lib/ranger-yarn-plugin-shim-1.2.0.3.1.4.0-315.jar:/usr/hdp/3.1.4.0-315/hadoop/lib/javax.servlet-api-3.1.0.jar:/usr/hdp/3.1.4.0-315/hadoop/lib/stax2-api-3.1.4.jar:/usr/hdp/3.1.4.0-315/hadoop/lib/
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ curl -sS --max-time 15 http://repo.geelib.qihoo.net:8360/nexus/repository/npm-mirrors-public/ink | head -c 300
curl: (28) Connection timed out after 15001 milliseconds
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ curl -sS --max-time 20 -o /dev/null -w "http_code=%{http_code} time_total=%{time_total}\n" \
>   http://repo.geelib.qihoo.net:8360/nexus/repository/npm-mirrors-public/ink/-/ink-5.1.0.tgz
'
.
/
\
';


^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm config set registry  https://npm.api.ops.qihoo.net --scope
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm config set prefer-offline true --scope
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm config set strict-ssl false --scope
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm ci --omit=dev

added 69 packages in 8s

24 packages are looking for funding
  run `npm fund` for details
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm fund
ai-cli@0.1.0
├── https://github.com/sponsors/mehmet-kozan
│   └── pdf-parse@2.4.5
├── https://github.com/sponsors/sindresorhus
│   └── ansi-escapes@7.3.0, environment@1.1.0, auto-bind@5.0.1, cli-boxes@3.0.0, cli-cursor@4.0.0, restore-cursor@4.0.0, onetime@5.1.2, cli-truncate@4.0.0, indent-string@5.0.0, is-in-ci@1.0.0, is-fullwidth-code-point@5.1.0, get-east-asian-width@1.6.0, string-width@7.2.0, type-fest@4.41.0, widest-line@5.0.0, is-fullwidth-code-point@4.0.0
├── https://github.com/chalk/ansi-styles?sponsor=1
│   └── ansi-styles@6.2.3
├── https://github.com/chalk/chalk?sponsor=1
│   └── chalk@5.6.2
└── https://github.com/chalk/wrap-ansi?sponsor=1
    └── wrap-ansi@9.0.2

j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm run build

> ai-cli@0.1.0 build
> esbuild src/cli.tsx --bundle --platform=node --target=node20 --format=esm --packages=external --jsx=automatic --banner:js="#!/usr/bin/env node" --outfile=dist/cli.js

sh: esbuild: command not found
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm ci

added 74 packages in 6s

24 packages are looking for funding
  run `npm fund` for details
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm run build

> ai-cli@0.1.0 build
> esbuild src/cli.tsx --bundle --platform=node --target=node20 --format=esm --packages=external --jsx=automatic --banner:js="#!/usr/bin/env node" --outfile=dist/cli.js


  dist/cli.js  197.5kb

⚡ Done in 37ms
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ npm link

added 1 package in 692ms
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ai
 ✦ ai · 首次设置
 没有检测到 API key，先把它填进来吧。

 1. 到你所用服务商的控制台申请并复制 API key
 （默认对接 https://api.deepseek.com；如需换服务商，先 ai --set-base-url 与 ai --set-model）。
 2. 在下面粘贴，按 Enter 保存。
 会写入 /data/oceanus_ctr/j-liutong3-jk/.ai/config.json（仅自己可读）；之后再启动就直接进对话。

 key › ╭──────────────────╮
       │ ❯  粘贴 API key… │
       ╰──────────────────╯
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ vi /data/oceanus_ctr/j-liutong3-jk/.ai/config.json
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ai
 ✦ ai
 deepseek-chat · https://api.deepseek.com

 ⚠ 再按一次 Ctrl+C 退出

 ╭─────────────────────────────────────────────────────────────────────────────────────────────────────────╮
 │ ❯  问点什么…                                                                                            │
 ╰─────────────────────────────────────────────────────────────────────────────────────────────────────────╯
  deepseek-chat · Enter 发送 · 行尾 \ 换行 · Esc 中断 · Ctrl+C×2 退出
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ^C
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ai --add-model
用法: ai --add-model <名字> model=<模型名> baseURL=<地址> [apiKey=<key>] [provider=<服务商>]
例:   ai --add-model qwen model=qwen-plus baseURL=https://dashscope.aliyuncs.com/compatible-mode/v1 apiKey=sk-xxx provider=通义千问
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$  ai --add-model doubao model=doubao-seed-2.1-turbo baseURL=https://llm-api-endpoint.oceanus.qihoo.net/v1 apiKey=sk-NmvwfgBkoBSfll2pNGTBW6b92mzecUUA5gm9SEf2094aygbV provider=qihoo
✓ 已保存模型「doubao」。当前共 1 个预设，用 ai --use-model doubao（或对话框内 /models）切换。
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ai --use-model doubao
✓ 已切换到「doubao」：doubao-seed-2.1-turbo @ https://llm-api-endpoint.oceanus.qihoo.net/v1
j-liutong3-jk@pboc-risk-yushu-dev01:~/agent$ ai
 ✦ ai
 doubao-seed-2.1-turbo · https://llm-api-endpoint.oceanus.qihoo.net/v1

 ❯ hello

 Hello! How can I help you today? I'm a coding agent that can help you with tasks like writing code, reading
 files, running commands, searching code, and more. Feel free to let me know what you need!

 ⚠ 再按一次 Ctrl+C 退出
