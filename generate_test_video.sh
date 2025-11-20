#!/bin/bash
set -e

# Generate a simple test H.264 test pattern video using ffmpeg

OUTPUT_DIR="build"
VIDEO_FILE="$OUTPUT_DIR/test_video.h264"

echo "Generating test H.264 video..."

mkdir -p "$OUTPUT_DIR"

ffmpeg -y \
    -f lavfi \
    -i testsrc=duration=10:size=1280x720:rate=30 \
    -vcodec libx264 \
    -profile:v high \
    -pix_fmt yuv420p \
    -bsf:v h264_mp4toannexb \
    -an \
    "$VIDEO_FILE"

echo ""
echo "Test video generated: $VIDEO_FILE"
echo "Video info:"
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,codec_name -of default=noprint_wrappers=1 "$VIDEO_FILE"
echo ""
echo "File size: $(du -h "$VIDEO_FILE" | cut -f1)"
