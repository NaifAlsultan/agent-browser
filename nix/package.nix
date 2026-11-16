{
  lib,
  rustPlatform,
  makeWrapper,
  google-chrome,
  xvfb,
}:

rustPlatform.buildRustPackage {
  pname = "agent-browser";
  version = "0.4.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../src
      ../vendor
    ];
  };

  cargoLock.lockFile = ../Cargo.lock;

  nativeBuildInputs = [ makeWrapper ];

  # Unit tests only; the integration tests need Chrome and a display.
  cargoTestFlags = [
    "--workspace"
    "--lib"
    "--bins"
  ];

  postInstall = ''
    wrapProgram $out/bin/agent-browser \
      --set-default AGENT_BROWSER_CHROME ${google-chrome}/bin/google-chrome-stable \
      --set-default AGENT_BROWSER_XVFB ${lib.getExe' xvfb "Xvfb"}
  '';

  meta = {
    description = "A background browser for AI agents, as an MCP server, built to avoid bot detection";
    license = lib.licenses.mit;
    mainProgram = "agent-browser";
    platforms = lib.platforms.linux;
  };
}
