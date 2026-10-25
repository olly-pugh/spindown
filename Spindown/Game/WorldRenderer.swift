import SwiftUI
import InRideKit

/// Draws the cartoon Lake District with parallax layers and the animated cyclist.
/// Scenery is placed by hashing world positions, so every lap looks the same at the same spot.
@MainActor
enum WorldRenderer {
    /// Screen pixels per metre for the road layer; far layers move proportionally slower.
    static let pxPerMetre = 9.0

    private static func rgb(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> Color {
        Color(red: r / 255, green: g / 255, blue: b / 255, opacity: a)
    }

    static func draw(_ g: inout GraphicsContext, size: CGSize, engine: GameEngine) {
        let w = size.width, h = size.height
        let horizon = h * 0.47
        let roadTop = h * 0.78
        let riderX = w * 0.30
        let s = min(w, h) / 380 // cyclist scale
        let o = engine.odometer * pxPerMetre

        drawSky(&g, w: w, horizon: horizon, time: engine.time, o: o)
        drawFells(&g, w: w, base: horizon + 6, amp: h * 0.20, p: 0.05, o: o, riderX: riderX, seed: 1.7,
                  fill: rgb(122, 148, 176), ridgeTint: rgb(150, 172, 196))
        drawFells(&g, w: w, base: horizon + 14, amp: h * 0.13, p: 0.13, o: o, riderX: riderX, seed: 4.2,
                  fill: rgb(96, 128, 92), ridgeTint: rgb(124, 150, 104))
        drawWater(&g, w: w, top: horizon + 10, bottom: horizon + h * 0.13, groundBottom: roadTop, p: 0.3, o: o, riderX: riderX, engine: engine)
        drawNearHills(&g, w: w, top: horizon + h * 0.12, bottom: roadTop, p: 0.55, o: o, riderX: riderX, s: s)
        drawVillage(&g, w: w, ground: roadTop - 4 * s, p: 0.75, o: o, riderX: riderX, s: s, engine: engine)
        drawRoad(&g, w: w, h: h, roadTop: roadTop, o: o, s: s)
        drawLandmarks(&g, w: w, roadTop: roadTop, o: o, riderX: riderX, s: s, engine: engine)
        let contactY = roadTop + 22 * s
        drawSpeedLines(&g, w: w, h: h, horizon: horizon, engine: engine)
        drawParticles(&g, riderX: riderX, contactY: contactY, w: w, h: h, s: s, engine: engine)
        drawCyclist(&g, x: riderX, contactY: contactY, s: s, engine: engine)
    }

    // MARK: Sky

    private static func drawSky(_ g: inout GraphicsContext, w: Double, horizon: Double, time: Double, o: Double) {
        let rect = CGRect(x: 0, y: 0, width: w, height: horizon + 40)
        g.fill(Path(rect), with: .linearGradient(Gradient(colors: [rgb(70, 150, 225), rgb(150, 205, 245), rgb(225, 240, 250)]),
                                                 startPoint: .zero, endPoint: CGPoint(x: 0, y: horizon + 40)))
        // Sun with glow.
        let sun = CGPoint(x: w * 0.82, y: horizon * 0.28)
        for (r, a) in [(70.0, 0.10), (48.0, 0.18), (30.0, 1.0)] {
            g.fill(Path(ellipseIn: CGRect(x: sun.x - r, y: sun.y - r, width: 2 * r, height: 2 * r)),
                   with: .color(rgb(255, 236, 140, a)))
        }
        // Clouds drift on their own and move a little with you.
        let spacing = 260.0
        let shift = o * 0.03 + time * 6
        let first = Int(((shift - 200) / spacing).rounded(.down))
        for k in first...(first + Int(w / spacing) + 3) {
            guard GameMath.hash(k * 13) > 0.25 else { continue }
            let x = Double(k) * spacing - shift + 60 * GameMath.hash(k * 5)
            let y = horizon * (0.12 + 0.45 * GameMath.hash(k * 17))
            let size = 0.7 + 0.6 * GameMath.hash(k * 23)
            for (dx, dy, r) in [(0.0, 0.0, 26.0), (26.0, -10.0, 30.0), (54.0, 0.0, 24.0), (26.0, 8.0, 26.0)] {
                let rr = r * size
                g.fill(Path(ellipseIn: CGRect(x: x + dx * size - rr, y: y + dy * size - rr * 0.7, width: 2 * rr, height: 1.4 * rr)),
                       with: .color(.white.opacity(0.92)))
            }
        }
    }

    // MARK: Fells and water

    private static func drawFells(_ g: inout GraphicsContext, w: Double, base: Double, amp: Double, p: Double,
                                  o: Double, riderX: Double, seed: Double, fill: Color, ridgeTint: Color) {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: base + 60))
        var x = 0.0
        while x <= w + 6 {
            let u = o * p + (x - riderX)
            path.addLine(to: CGPoint(x: x, y: base - amp * GameMath.ridge(u, seed: seed)))
            x += 6
        }
        path.addLine(to: CGPoint(x: w, y: base + 60))
        path.closeSubpath()
        g.fill(path, with: .color(fill))
        g.stroke(path, with: .color(ridgeTint), lineWidth: 2)
    }

    private static func drawWater(_ g: inout GraphicsContext, w: Double, top: Double, bottom: Double, groundBottom: Double,
                                  p: Double, o: Double, riderX: Double, engine: GameEngine) {
        // Meadow under everything down to the road, so no sky shows through anywhere.
        g.fill(Path(CGRect(x: 0, y: top, width: w, height: groundBottom - top)), with: .color(rgb(150, 190, 100)))
        let slices = 120
        let sliceW = (w / Double(slices)).rounded(.up)
        var amounts: [Double] = []
        for i in 0..<slices {
            let x = Double(i) * sliceW
            let metres = engine.odometer + (x + sliceW / 2 - riderX) / (pxPerMetre * p)
            amounts.append((LakeRoute.lakeAmount(at: metres) * 40).rounded() / 40)
        }
        var i = 0
        while i < slices {
            var j = i
            while j + 1 < slices, amounts[j + 1] == amounts[i] { j += 1 }
            if amounts[i] > 0 {
                let rect = CGRect(x: Double(i) * sliceW, y: top, width: Double(j - i + 1) * sliceW, height: bottom - top)
                g.fill(Path(rect), with: .linearGradient(Gradient(colors: [rgb(90, 150, 200, amounts[i]), rgb(40, 100, 160, amounts[i])]),
                                                         startPoint: CGPoint(x: 0, y: top), endPoint: CGPoint(x: 0, y: bottom)))
            }
            i = j + 1
        }
        // Shimmer and the odd sailing boat on the water.
        let shimmerShift = o * p + engine.time * 12
        for k in 0..<40 {
            let x = (Double(k) * 53 - shimmerShift).truncatingRemainder(dividingBy: w + 60)
            let xx = x < 0 ? x + w + 60 : x
            let metres = engine.odometer + (xx - riderX) / (pxPerMetre * p)
            guard LakeRoute.lakeAmount(at: metres) > 0.5 else { continue }
            let y = top + 6 + (bottom - top - 12) * GameMath.hash(k * 3)
            var line = Path()
            line.move(to: CGPoint(x: xx, y: y))
            line.addLine(to: CGPoint(x: xx + 14 + 10 * GameMath.hash(k), y: y))
            g.stroke(line, with: .color(.white.opacity(0.55)), lineWidth: 1.5)
        }
        let boatSpacing = 900.0
        let first = Int(((o * p - riderX) / boatSpacing).rounded(.down)) - 1
        for k in first...(first + Int(w / boatSpacing) + 2) where GameMath.hash(k * 41) > 0.5 {
            let x = Double(k) * boatSpacing - o * p + riderX + engine.time * 4
            let metres = engine.odometer + (x - riderX) / (pxPerMetre * p)
            guard LakeRoute.lakeAmount(at: metres) > 0.8 else { continue }
            let y = top + (bottom - top) * 0.55
            var hull = Path()
            hull.move(to: CGPoint(x: x - 14, y: y)); hull.addLine(to: CGPoint(x: x + 14, y: y))
            hull.addLine(to: CGPoint(x: x + 9, y: y + 6)); hull.addLine(to: CGPoint(x: x - 9, y: y + 6)); hull.closeSubpath()
            g.fill(hull, with: .color(rgb(140, 60, 40)))
            var sail = Path()
            sail.move(to: CGPoint(x: x, y: y - 26)); sail.addLine(to: CGPoint(x: x, y: y - 2)); sail.addLine(to: CGPoint(x: x + 14, y: y - 2)); sail.closeSubpath()
            g.fill(sail, with: .color(.white))
        }
    }

    // MARK: Near hills, walls, trees and sheep

    private static func nearHillY(_ u: Double, top: Double) -> Double {
        top + 14 + 16 * sin(u * 0.006) + 8 * sin(u * 0.017 + 1)
    }

    private static func drawNearHills(_ g: inout GraphicsContext, w: Double, top: Double, bottom: Double, p: Double,
                                      o: Double, riderX: Double, s: Double) {
        var hill = Path()
        hill.move(to: CGPoint(x: 0, y: bottom + 10))
        var x = 0.0
        while x <= w + 6 {
            hill.addLine(to: CGPoint(x: x, y: nearHillY(o * p + x - riderX, top: top)))
            x += 6
        }
        hill.addLine(to: CGPoint(x: w, y: bottom + 10))
        hill.closeSubpath()
        g.fill(hill, with: .linearGradient(Gradient(colors: [rgb(120, 180, 70), rgb(80, 140, 50)]),
                                           startPoint: CGPoint(x: 0, y: top), endPoint: CGPoint(x: 0, y: bottom)))

        // Dry-stone wall following the hillside.
        var wall = Path()
        x = 0
        while x <= w + 6 {
            let y = nearHillY(o * p + x - riderX, top: top) + 26
            x == 0 ? wall.move(to: CGPoint(x: x, y: y)) : wall.addLine(to: CGPoint(x: x, y: y))
            x += 6
        }
        g.stroke(wall, with: .color(rgb(140, 140, 135)), style: StrokeStyle(lineWidth: 5 * s, lineCap: .round))
        g.stroke(wall, with: .color(rgb(95, 95, 92)), style: StrokeStyle(lineWidth: 1.5 * s, dash: [3 * s, 5 * s]))

        // Trees.
        let treeSpacing = 70.0
        var first = Int(((o * p - riderX - 60) / treeSpacing).rounded(.down))
        for k in first...(first + Int(w / treeSpacing) + 3) where GameMath.hash(k * 11) > 0.45 {
            let tx = Double(k) * treeSpacing + 30 * GameMath.hash(k * 3) - o * p + riderX
            let base = nearHillY(o * p + tx - riderX, top: top) + 18
            let size = (0.8 + 0.5 * GameMath.hash(k * 19)) * s
            g.fill(Path(CGRect(x: tx - 2 * size, y: base - 16 * size, width: 4 * size, height: 16 * size)), with: .color(rgb(100, 70, 45)))
            for (dx, dy, r, shade) in [(-7.0, -20.0, 10.0, 0.0), (6.0, -22.0, 11.0, 0.08), (0.0, -32.0, 11.0, 0.15)] {
                g.fill(Path(ellipseIn: CGRect(x: tx + dx * size - r * size, y: base + dy * size - r * size, width: 2 * r * size, height: 2 * r * size)),
                       with: .color(rgb(40 + 60 * shade, 105 + 60 * shade, 50)))
            }
        }

        // Sheep (the HUD counts the ones you pass).
        let sheepSpacing = 37 * pxPerMetre * p
        first = Int(((o * p - riderX - 60) / sheepSpacing).rounded(.down))
        for k in first...(first + Int(w / sheepSpacing) + 3) where GameMath.hash(k * 7 + 3) > 0.72 {
            let sx = Double(k) * sheepSpacing - o * p + riderX
            let sy = nearHillY(o * p + sx - riderX, top: top) + 40 + 8 * GameMath.hash(k)
            let b = 1.0 * s
            g.fill(Path(ellipseIn: CGRect(x: sx - 9 * b, y: sy - 6 * b, width: 18 * b, height: 12 * b)), with: .color(.white))
            g.fill(Path(ellipseIn: CGRect(x: sx + 6 * b, y: sy - 8 * b, width: 7 * b, height: 6 * b)), with: .color(rgb(30, 30, 30)))
            for lx in [-5.0, 4.0] {
                g.fill(Path(CGRect(x: sx + lx * b, y: sy + 4 * b, width: 2 * b, height: 5 * b)), with: .color(rgb(30, 30, 30)))
            }
        }
    }

    // MARK: Villages

    private static func drawVillage(_ g: inout GraphicsContext, w: Double, ground: Double, p: Double, o: Double,
                                    riderX: Double, s: Double, engine: GameEngine) {
        guard LakeRoute.villageAmount(at: engine.odometer) > 0 || LakeRoute.villageAmount(at: engine.odometer + 60) > 0 else { return }
        let spacing = 80.0
        let first = Int(((o * p - riderX - 80) / spacing).rounded(.down))
        for k in first...(first + Int(w / spacing) + 3) {
            let cx = Double(k) * spacing - o * p + riderX
            let metres = engine.odometer + (cx - riderX) / (pxPerMetre * p)
            guard LakeRoute.villageAmount(at: metres) > 0.25 + 0.5 * GameMath.hash(k * 29) else { continue }
            let cw = (34 + 16 * GameMath.hash(k)) * s
            let ch = (22 + 8 * GameMath.hash(k * 2)) * s
            let base = ground
            let walls = CGRect(x: cx - cw / 2, y: base - ch, width: cw, height: ch)
            g.fill(Path(walls), with: .color(GameMath.hash(k * 3) > 0.4 ? rgb(245, 243, 235) : rgb(160, 160, 155)))
            var roof = Path()
            roof.move(to: CGPoint(x: walls.minX - 4 * s, y: walls.minY))
            roof.addLine(to: CGPoint(x: walls.midX, y: walls.minY - 14 * s))
            roof.addLine(to: CGPoint(x: walls.maxX + 4 * s, y: walls.minY))
            roof.closeSubpath()
            g.fill(roof, with: .color(rgb(70, 75, 85)))
            g.fill(Path(CGRect(x: walls.maxX - 9 * s, y: walls.minY - 16 * s, width: 5 * s, height: 10 * s)), with: .color(rgb(110, 100, 95)))
            g.fill(Path(CGRect(x: walls.midX - 3 * s, y: base - 11 * s, width: 6 * s, height: 11 * s)),
                   with: .color(GameMath.hash(k * 5) > 0.5 ? rgb(40, 90, 60) : rgb(150, 30, 40)))
            for wx in [walls.minX + 5 * s, walls.maxX - 11 * s] {
                g.fill(Path(CGRect(x: wx, y: walls.minY + 5 * s, width: 6 * s, height: 6 * s)), with: .color(rgb(90, 140, 180)))
            }
        }
    }

    // MARK: Road and landmarks

    private static func drawRoad(_ g: inout GraphicsContext, w: Double, h: Double, roadTop: Double, o: Double, s: Double) {
        g.fill(Path(CGRect(x: 0, y: roadTop - 6 * s, width: w, height: 6 * s)), with: .color(rgb(90, 150, 60)))
        let road = CGRect(x: 0, y: roadTop, width: w, height: h * 0.14)
        g.fill(Path(road), with: .color(rgb(85, 88, 95)))
        g.fill(Path(CGRect(x: 0, y: roadTop, width: w, height: 2 * s)), with: .color(.white.opacity(0.8)))
        let dash = 34.0, gap = 30.0
        let period = dash + gap
        var x = -(o.truncatingRemainder(dividingBy: period))
        while x < w {
            g.fill(Path(CGRect(x: x, y: road.midY - 1.5 * s, width: dash, height: 3 * s)), with: .color(rgb(240, 220, 120)))
            x += period
        }
        g.fill(Path(CGRect(x: 0, y: road.maxY, width: w, height: h - road.maxY)), with: .color(rgb(95, 155, 60)))
    }

    private static func drawLandmarks(_ g: inout GraphicsContext, w: Double, roadTop: Double, o: Double, riderX: Double,
                                      s: Double, engine: GameEngine) {
        let lapStart = (engine.odometer / LakeRoute.lapLength).rounded(.down) * LakeRoute.lapLength
        for offset in [-LakeRoute.lapLength, 0, LakeRoute.lapLength] {
            for l in LakeRoute.landmarks {
                let x = (lapStart + offset + l.distance) * pxPerMetre - o + riderX
                guard x > -200, x < w + 200 else { continue }
                if l.kind == .start {
                    drawArch(&g, x: x, roadTop: roadTop, s: s, lap: LakeRoute.lap(lapStart + offset + 1))
                } else {
                    drawSign(&g, x: x, roadTop: roadTop, s: s, text: l.name)
                }
            }
        }
    }

    private static func drawSign(_ g: inout GraphicsContext, x: Double, roadTop: Double, s: Double, text: String) {
        g.fill(Path(CGRect(x: x - 2 * s, y: roadTop - 60 * s, width: 4 * s, height: 56 * s)), with: .color(rgb(70, 70, 70)))
        let board = CGRect(x: x - 60 * s, y: roadTop - 86 * s, width: 120 * s, height: 30 * s)
        g.fill(Path(roundedRect: board, cornerRadius: 4 * s), with: .color(rgb(0, 110, 70)))
        g.stroke(Path(roundedRect: board.insetBy(dx: 2 * s, dy: 2 * s), cornerRadius: 3 * s), with: .color(.white), lineWidth: 1.5 * s)
        g.draw(Text(text).font(.system(size: 11 * s, weight: .bold)).foregroundStyle(.white),
               at: CGPoint(x: board.midX, y: board.midY))
    }

    private static func drawArch(_ g: inout GraphicsContext, x: Double, roadTop: Double, s: Double, lap: Int) {
        for px in [x - 70 * s, x + 64 * s] {
            g.fill(Path(CGRect(x: px, y: roadTop - 110 * s, width: 6 * s, height: 140 * s)), with: .color(rgb(60, 60, 60)))
        }
        let banner = CGRect(x: x - 76 * s, y: roadTop - 128 * s, width: 152 * s, height: 26 * s)
        let cell = 6.5 * s
        var cy = banner.minY
        var row = 0
        while cy < banner.maxY {
            var cx = banner.minX
            var col = 0
            while cx < banner.maxX {
                g.fill(Path(CGRect(x: cx, y: cy, width: min(cell, banner.maxX - cx), height: min(cell, banner.maxY - cy))),
                       with: .color((row + col) % 2 == 0 ? .black : .white))
                cx += cell; col += 1
            }
            cy += cell; row += 1
        }
        let label = CGRect(x: x - 52 * s, y: roadTop - 124 * s, width: 104 * s, height: 18 * s)
        g.fill(Path(roundedRect: label, cornerRadius: 3 * s), with: .color(rgb(220, 40, 40)))
        g.draw(Text(lap == 1 ? "WINDERMERE" : "LAP \(lap)").font(.system(size: 11 * s, weight: .heavy)).foregroundStyle(.white),
               at: CGPoint(x: label.midX, y: label.midY))
    }

    // MARK: Effects

    private static func drawSpeedLines(_ g: inout GraphicsContext, w: Double, h: Double, horizon: Double, engine: GameEngine) {
        let kph = engine.speed * 3.6
        guard kph > 33 else { return }
        let strength = min(1, (kph - 33) / 12)
        for k in 0..<14 {
            let y = horizon * 0.3 + (h * 0.75 - horizon * 0.3) * GameMath.hash(k * 37)
            let len = 40 + 80 * GameMath.hash(k * 3)
            let x = (w + 200) - ((engine.time * (500 + 300 * GameMath.hash(k)) + 150 * Double(k)).truncatingRemainder(dividingBy: w + 300))
            var line = Path()
            line.move(to: CGPoint(x: x, y: y))
            line.addLine(to: CGPoint(x: x + len, y: y))
            g.stroke(line, with: .color(.white.opacity(0.35 * strength)), lineWidth: 2)
        }
    }

    private static func drawParticles(_ g: inout GraphicsContext, riderX: Double, contactY: Double, w: Double, h: Double,
                                      s: Double, engine: GameEngine) {
        for p in engine.particles {
            if p.hue == 0 {
                let x = riderX - 34 * s + p.x * s * 0.4
                let y = contactY + p.y * s * 0.2
                g.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 3 * s, height: 3 * s)), with: .color(.white.opacity(0.4 * p.life)))
            } else {
                let x = w / 2 + p.x
                let y = h * 0.45 + p.y
                g.fill(Path(CGRect(x: x, y: y, width: 6, height: 9)),
                       with: .color(Color(hue: p.hue, saturation: 0.9, brightness: 1).opacity(min(1, p.life))))
            }
        }
    }

    // MARK: Cyclist

    private static func knee(hip: CGPoint, foot: CGPoint, thigh: Double, shin: Double) -> CGPoint {
        let dx = foot.x - hip.x, dy = foot.y - hip.y
        let d = min(max(hypot(dx, dy), abs(thigh - shin) + 0.01), thigh + shin - 0.01)
        let a = acos((thigh * thigh + d * d - shin * shin) / (2 * thigh * d))
        let phi = atan2(dy, dx)
        let k1 = CGPoint(x: hip.x + thigh * cos(phi + a), y: hip.y + thigh * sin(phi + a))
        let k2 = CGPoint(x: hip.x + thigh * cos(phi - a), y: hip.y + thigh * sin(phi - a))
        return k1.x > k2.x ? k1 : k2 // knees point forward
    }

    private static func line(_ g: inout GraphicsContext, _ points: [CGPoint], _ color: Color, _ width: Double) {
        var p = Path()
        p.addLines(points)
        g.stroke(p, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
    }

    private static func drawWheel(_ g: inout GraphicsContext, at c: CGPoint, r: Double, s: Double, angle: Double) {
        let rect = CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)
        g.stroke(Path(ellipseIn: rect), with: .color(rgb(25, 25, 25)), lineWidth: 4 * s)
        g.stroke(Path(ellipseIn: rect.insetBy(dx: 2.5 * s, dy: 2.5 * s)), with: .color(rgb(190, 190, 195)), lineWidth: 1.2 * s)
        for i in 0..<8 {
            let a: Double = angle + Double(i) * Double.pi / 4
            let spoke: Double = r - 3 * s
            let end = CGPoint(x: c.x + spoke * cos(a), y: c.y + spoke * sin(a))
            line(&g, [c, end], rgb(200, 200, 205), 0.8 * s)
        }
        g.fill(Path(ellipseIn: CGRect(x: c.x - 2.5 * s, y: c.y - 2.5 * s, width: 5 * s, height: 5 * s)), with: .color(rgb(60, 60, 60)))
    }

    private static func drawCyclist(_ g: inout GraphicsContext, x: Double, contactY: Double, s: Double, engine: GameEngine) {
        let r = 24 * s
        let theta = engine.crankAngle
        let bob = sin(2 * theta) * 1.2 * s * min(1, engine.speed / 3)

        g.fill(Path(ellipseIn: CGRect(x: x - 50 * s, y: contactY - 3 * s, width: 100 * s, height: 7 * s)), with: .color(.black.opacity(0.25)))

        let rear = CGPoint(x: x - 34 * s, y: contactY - r)
        let front = CGPoint(x: x + 34 * s, y: contactY - r)
        let bb = CGPoint(x: x - 6 * s, y: contactY - r + 2 * s)
        let seat = CGPoint(x: x - 16 * s, y: contactY - r - 40 * s)
        let head = CGPoint(x: x + 22 * s, y: contactY - r - 36 * s)
        let hip = CGPoint(x: seat.x - 1 * s, y: seat.y - 6 * s + bob)
        let shoulder = CGPoint(x: x + 13 * s, y: contactY - r - 66 * s + bob)
        let crank = 8 * s
        func pedal(_ a: Double) -> CGPoint { CGPoint(x: bb.x + crank * cos(a), y: bb.y + crank * sin(a)) }

        let skin = rgb(240, 200, 165)
        let shorts = rgb(25, 25, 35)
        let jersey = rgb(230, 50, 60)

        // Far leg behind the bike.
        let farFoot = pedal(theta + .pi)
        line(&g, [hip, knee(hip: hip, foot: farFoot, thigh: 28 * s, shin: 27 * s), farFoot], rgb(15, 15, 22), 6 * s)

        drawWheel(&g, at: rear, r: r, s: s, angle: engine.wheelAngle)
        drawWheel(&g, at: front, r: r, s: s, angle: engine.wheelAngle)
        let frame = rgb(20, 120, 210)
        line(&g, [rear, bb, seat, rear], frame, 3 * s)
        line(&g, [bb, head, seat], frame, 3 * s)
        line(&g, [head, front], rgb(40, 40, 40), 2.5 * s)
        line(&g, [CGPoint(x: seat.x - 7 * s, y: seat.y - 3 * s), CGPoint(x: seat.x + 6 * s, y: seat.y - 4 * s)], rgb(30, 30, 30), 3 * s)
        line(&g, [head, CGPoint(x: head.x + 9 * s, y: head.y - 3 * s), CGPoint(x: head.x + 12 * s, y: head.y + 4 * s),
                  CGPoint(x: head.x + 7 * s, y: head.y + 7 * s)], rgb(30, 30, 30), 2.5 * s)
        line(&g, [pedal(theta + .pi), pedal(theta)], rgb(70, 70, 75), 2 * s)

        // Torso, head and helmet.
        line(&g, [hip, shoulder], jersey, 10 * s)
        line(&g, [CGPoint(x: hip.x + 3 * s, y: hip.y - 4 * s), CGPoint(x: shoulder.x - 1 * s, y: shoulder.y + 1 * s)], .white, 2 * s)
        let headCenter = CGPoint(x: shoulder.x + 9 * s, y: shoulder.y - 9 * s)
        g.fill(Path(ellipseIn: CGRect(x: headCenter.x - 7 * s, y: headCenter.y - 7 * s, width: 14 * s, height: 14 * s)), with: .color(skin))
        var helmet = Path()
        helmet.addArc(center: headCenter, radius: 8 * s, startAngle: .degrees(190), endAngle: .degrees(350), clockwise: false)
        helmet.closeSubpath()
        g.fill(helmet, with: .color(rgb(255, 210, 30)))
        g.fill(Path(ellipseIn: CGRect(x: headCenter.x + 2 * s, y: headCenter.y - 2 * s, width: 6 * s, height: 3 * s)), with: .color(.black.opacity(0.8)))

        // Arm to the bars.
        let hands = CGPoint(x: head.x + 10 * s, y: head.y - 1 * s)
        line(&g, [shoulder, CGPoint(x: shoulder.x + 9 * s, y: shoulder.y + 12 * s + bob * 0.5), hands], jersey, 4.5 * s)
        g.fill(Path(ellipseIn: CGRect(x: hands.x - 2.5 * s, y: hands.y - 2.5 * s, width: 5 * s, height: 5 * s)), with: .color(skin))

        // Near leg in front.
        let nearFoot = pedal(theta)
        let nearKnee = knee(hip: hip, foot: nearFoot, thigh: 28 * s, shin: 27 * s)
        line(&g, [hip, nearKnee], shorts, 7 * s)
        line(&g, [nearKnee, nearFoot], skin, 5.5 * s)
        line(&g, [CGPoint(x: nearFoot.x - 3 * s, y: nearFoot.y), CGPoint(x: nearFoot.x + 6 * s, y: nearFoot.y + 1 * s)], rgb(240, 240, 240), 4 * s)
    }
}
