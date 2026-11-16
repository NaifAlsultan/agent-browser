{
  description = "agent-browser: a background browser for AI agents, as an MCP server, built to avoid bot detection";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (pkgsFor system));
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfreePredicate = pkg: nixpkgs.lib.getName pkg == "google-chrome";
        };
    in
    {
      packages = forAllSystems (pkgs: rec {
        agent-browser = pkgs.callPackage ./nix/package.nix { };
        default = agent-browser;
      });

      # Unit tests run in the package's check phase; integration tests need a display (cargo test in the dev shell).
      checks = forAllSystems (
        pkgs:
        let
          agent-browser = self.packages.${pkgs.stdenv.hostPlatform.system}.agent-browser;
        in
        {
          unit = agent-browser;
          clippy = agent-browser.overrideAttrs (old: {
            pname = "agent-browser-clippy";
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./Cargo.toml
                ./Cargo.lock
                ./src
                ./vendor
                ./tests
                ./examples
              ];
            };
            nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.clippy ];
            buildPhase = ''
              runHook preBuild
              cargo clippy --workspace --all-targets --offline -- -D warnings
              runHook postBuild
            '';
            doCheck = false;
            installPhase = "touch $out";
          });
          # Only agent-browser's own code: the vendored crates keep upstream's formatting.
          rustfmt =
            pkgs.runCommand "agent-browser-rustfmt"
              {
                nativeBuildInputs = [ pkgs.rustfmt ];
                src = pkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = pkgs.lib.fileset.unions [
                    ./rustfmt.toml
                    ./src
                    ./tests
                    ./examples
                  ];
                };
              }
              ''
                cd $src
                rustfmt --check src/main.rs tests/integration.rs examples/*.rs
                touch $out
              '';
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.cargo
            pkgs.rustc
            pkgs.clippy
            pkgs.rustfmt
            pkgs.rust-analyzer
            pkgs.google-chrome
            pkgs.xvfb
          ];
          AGENT_BROWSER_CHROME = "${pkgs.google-chrome}/bin/google-chrome-stable";
          AGENT_BROWSER_XVFB = "${pkgs.xvfb}/bin/Xvfb";
          # For the vendored crates' Chromium tests.
          BROWSE_TEST_CHROME = "${pkgs.google-chrome}/bin/google-chrome-stable";
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
