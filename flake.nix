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

      # Unit tests run in the package's check phase; integration tests need a display (npm run test:integration).
      checks = forAllSystems (pkgs: {
        unit = self.packages.${pkgs.stdenv.hostPlatform.system}.agent-browser;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.google-chrome
            pkgs.xvfb
            pkgs.util-linux
            pkgs.xprop
          ];
          AGENT_BROWSER_CHROME = "${pkgs.google-chrome}/bin/google-chrome-stable";
          AGENT_BROWSER_XVFB = "${pkgs.xvfb}/bin/Xvfb";
          AGENT_BROWSER_SETPRIV = "${pkgs.util-linux}/bin/setpriv";
          AGENT_BROWSER_XPROP = "${pkgs.xprop}/bin/xprop";
          # For scripts/detection-compare.ts.
          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
