# Replit system dependencies. Both binaries are required — see SYSTEM-DEPS.md.
{ pkgs }: {
  deps = [
    pkgs.python311
    pkgs.ghostscript   # tiffsep: one greyscale plate per separation
    pkgs.mupdf         # mutool draw -F svg: vector plate extraction
  ];
}
