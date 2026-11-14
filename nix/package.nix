{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
  google-chrome,
  xvfb,
  util-linux,
  xprop,
}:

buildNpmPackage {
  pname = "agent-browser";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../src
      ../vendor
      ../test
    ];
  };

  nodejs = nodejs_24;
  npmDepsHash = "sha256-PoJe1o3V6Ma/rFodSnkGaJGFSq2OeoDgfBXs3nG9DtI=";
  dontNpmBuild = true;
  npmFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [ makeWrapper ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npx tsc --noEmit -p tsconfig.json
    node --test --test-concurrency=1 'test/unit/**/*.test.ts'
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts --no-audit --no-fund
    mkdir -p $out/lib/agent-browser
    cp -r package.json src vendor node_modules $out/lib/agent-browser/
    makeWrapper ${lib.getExe nodejs_24} $out/bin/agent-browser \
      --add-flags $out/lib/agent-browser/src/main.ts \
      --set-default AGENT_BROWSER_CHROME ${google-chrome}/bin/google-chrome-stable \
      --set-default AGENT_BROWSER_XVFB ${lib.getExe' xvfb "Xvfb"} \
      --set-default AGENT_BROWSER_SETPRIV ${lib.getExe' util-linux "setpriv"} \
      --set-default AGENT_BROWSER_XPROP ${lib.getExe xprop}
    runHook postInstall
  '';

  meta = {
    description = "A background browser for AI agents, as an MCP server, built to avoid bot detection";
    license = lib.licenses.mit;
    mainProgram = "agent-browser";
    platforms = lib.platforms.linux;
  };
}
