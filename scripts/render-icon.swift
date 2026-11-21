#!/usr/bin/env swift
/*
 * Render the Myna brand mark to the repository's PNG assets and the iconset
 * used to build assets/Myna.icns.
 *
 * The geometry is the same mynaMark the menu bar host draws in
 * native/menubar.swift, on an 18×18 grid in AppKit coordinates. Keep the two in
 * sync: change one, then change the other.
 *
 * Usage:
 *   swift scripts/render-icon.swift
 *
 * Outputs:
 *   assets/myna-icon.png          1024px, brand green on transparent
 *   assets/myna-icon-inverse.png  1024px, white on transparent (dark backgrounds)
 *   assets/Myna.iconset/           16–1024px, then build the icns with:
 *     iconutil -c icns assets/Myna.iconset -o assets/Myna.icns
 */

import AppKit

let brandGreen = NSColor(srgbRed: 20.0 / 255.0, green: 33.0 / 255.0, blue: 31.0 / 255.0, alpha: 1)

enum RenderError: Error {
    case bitmap(Int)
    case png(Int)
}

/* Draw the mark in 18×18 grid units into the current graphics context. */
func drawMark(_ color: NSColor, phase: Int = 0) {
    color.setFill()

    /* Head: circle centered on (8.0, 8.6). */
    NSBezierPath(ovalIn: NSRect(x: 3.0, y: 3.6, width: 10.0, height: 10.0)).fill()

    /* Beak: tapered wedge rooted inside the head, tip slightly lifted. */
    let beak = NSBezierPath()
    beak.move(to: NSPoint(x: 11.3, y: 10.7))
    beak.line(to: NSPoint(x: 17.0, y: 9.1))
    beak.line(to: NSPoint(x: 11.3, y: 6.5))
    beak.close()
    beak.fill()

    /* Crest: three sound bars. Phase 0 is the symmetric resting pose. */
    let patterns: [[CGFloat]] = [
        [3.0, 4.4, 3.0],
        [4.4, 3.2, 4.0],
        [3.2, 4.4, 2.6],
        [4.2, 2.8, 3.8],
    ]
    let bars = patterns[phase % patterns.count]
    for (index, height) in bars.enumerated() {
        NSBezierPath(
            roundedRect: NSRect(x: 4.6 + CGFloat(index) * 2.6, y: 12.5, width: 1.6, height: height),
            xRadius: 0.8,
            yRadius: 0.8
        ).fill()
    }

    /* Eye: clear a hole up and forward of the head's center. */
    if let context = NSGraphicsContext.current {
        context.compositingOperation = .clear
        NSBezierPath(ovalIn: NSRect(x: 8.5, y: 8.9, width: 1.8, height: 1.8)).fill()
        context.compositingOperation = .sourceOver
    }
}

/* Render the mark at an exact pixel size. `inset` is a fraction of the side
 * reserved as padding around the 18-unit grid (0 uses the grid's own margins). */
func renderMarkPNG(side: Int, color: NSColor, inset: CGFloat = 0, phase: Int = 0) throws -> Data {
    guard
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: side,
            pixelsHigh: side,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        )
    else { throw RenderError.bitmap(side) }
    rep.size = NSSize(width: side, height: side)

    NSGraphicsContext.saveGraphicsState()
    guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
        NSGraphicsContext.restoreGraphicsState()
        throw RenderError.bitmap(side)
    }
    NSGraphicsContext.current = context

    let padding = CGFloat(side) * max(0, inset)
    let scale = (CGFloat(side) - padding * 2) / 18
    let transform = NSAffineTransform()
    transform.translateX(by: padding, yBy: padding)
    transform.scale(by: scale)
    transform.concat()

    drawMark(color, phase: phase)
    NSGraphicsContext.restoreGraphicsState()

    guard let png = rep.representation(using: .png, properties: [:]) else {
        throw RenderError.png(side)
    }
    return png
}

func writePNG(_ data: Data, to url: URL) throws {
    try data.write(to: url)
    print("wrote \(url.path)")
}

let scriptURL = URL(fileURLWithPath: #filePath)
let root = scriptURL.deletingLastPathComponent().deletingLastPathComponent()
let assets = root.appendingPathComponent("assets")

try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)

/* README art: the mark with its own grid margins, light and dark variants. */
try writePNG(
    try renderMarkPNG(side: 1024, color: brandGreen),
    to: assets.appendingPathComponent("myna-icon.png")
)
try writePNG(
    try renderMarkPNG(side: 1024, color: .white),
    to: assets.appendingPathComponent("myna-icon-inverse.png")
)

/* App iconset: the mark with a little extra padding so it breathes at
 * Finder sizes. iconutil turns this into Myna.icns. */
let iconset = assets.appendingPathComponent("Myna.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

let iconsetSizes: [(String, Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]
for (name, side) in iconsetSizes {
    try writePNG(
        try renderMarkPNG(side: side, color: brandGreen, inset: 0.10),
        to: iconset.appendingPathComponent(name)
    )
}

print("done — build the icns with: iconutil -c icns assets/Myna.iconset -o assets/Myna.icns")
