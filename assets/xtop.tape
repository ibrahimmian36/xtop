# Records the xtop demo GIF with VHS (https://github.com/charmbracelet/vhs).
# Run from the repo root:   vhs assets/xtop.tape   ->   assets/xtop.gif
#
# Needs: vhs (+ ffmpeg, ttyd) and the yeet daemon running.
# Tip: kick off a fork/exec storm in another shell while recording so the
# tree, feed, and rate heatmap fill up on camera, e.g.:
#   while :; do for i in $(seq 12); do (sleep 0.1; true) & done; wait; sleep 1; done

Output "assets/xtop.gif"

Set Shell      "bash"
Set FontSize   13
Set Width      1500
Set Height     1000
Set Padding    14
Set Framerate  24

# Launch xtop and let it warm up off-camera, so the GIF opens directly on
# the live dashboard instead of a blank prompt.
Hide
Type "yeet run https://github.com/yeet-src/xtop -- --anonymize"
Enter
Sleep 6s
Show

# Recording: the live dashboard.
Sleep 18s

Ctrl+C
Sleep 500ms
