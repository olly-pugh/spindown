import Foundation

public struct ExportableRide: Sendable {
    public var record: RideRecord
    public var track: RideTrack

    public init(record: RideRecord, track: RideTrack) {
        self.record = record
        self.track = track
    }

    var start: Date { record.startDate }
    var end: Date { record.endDate }
}

public enum ExportFormat: String, CaseIterable, Sendable, Identifiable {
    case fit, tcx, csv
    public var id: String { rawValue }
    public var fileExtension: String { rawValue }
    public var displayName: String {
        switch self {
        case .fit: return "FIT (Garmin, Strava, TrainingPeaks)"
        case .tcx: return "TCX (Training Center XML)"
        case .csv: return "CSV (spreadsheet)"
        }
    }
}

public enum ActivityExporter {
    public static let productName = "Spindown"
    public static let softwareVersion = 100 // 1.00

    public static func export(_ ride: ExportableRide, as format: ExportFormat) -> Data {
        switch format {
        case .fit: return fit(ride)
        case .tcx: return tcx(ride)
        case .csv: return csv(ride)
        }
    }

    public static func fileName(for ride: ExportableRide, format: ExportFormat) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd-HHmm"
        return "Spindown-\(f.string(from: ride.start)).\(format.fileExtension)"
    }

    // MARK: FIT

    /// FIT activity: sport cycling / sub-sport indoor cycling, so Garmin files it as
    /// "Indoor Cycling" and Strava as an indoor ride.
    public static func fit(_ ride: ExportableRide, timeZone: TimeZone = .current) -> Data {
        let s = ride.record.summary
        let startTS = FITWriter.timestamp(ride.start)
        let endTS = max(FITWriter.timestamp(ride.end), startTS + UInt32(max(0, s.elapsedTime.rounded(.down))))
        var w = FITWriter()

        // file_id
        w.write(global: 0, [
            .enumeration(0, 4),                    // type = activity
            .u16(1, 255),                          // manufacturer = development
            .u16(2, 1),                            // product
            .u32z(3, serial(for: ride.record.id)), // serial_number
            .u32(4, Int(startTS)),                 // time_created
            .text(8, productName),                 // product_name
        ])

        // device_info: the creator (this app) and the trainer.
        w.write(global: 23, [
            .u32(253, Int(startTS)), .u8(0, 0), .u16(2, 255), .u16(4, 1), .u16(5, softwareVersion), .text(27, productName),
        ])
        w.write(global: 23, [
            .u32(253, Int(startTS)), .u8(0, 1), .u16(2, 290), .u16(4, 0), .u16(5, nil),  // 290 = kinetic_by_kurt
            .text(27, ride.record.trainer?.model ?? "inRide"),
        ])

        // Timer events and records, merged in time order.
        var events = ride.track.timerEvents.map { (t: $0.t, start: $0.kind == .start) }
        if events.first?.t != 0 || events.first?.start != true { events.insert((0, true), at: 0) }
        var eventIndex = 0
        var lastRecordTS: UInt32?

        func writeEvent(_ e: (t: Double, start: Bool)) {
            w.write(global: 21, [
                .u32(253, Int(startTS) + Int(e.t.rounded(.down))),
                .enumeration(0, 0),                   // event = timer
                .enumeration(1, e.start ? 0 : 4),     // start / stop_all
                .u8(4, 0),                            // event_group
            ])
        }

        for sample in ride.track.samples {
            while eventIndex < events.count, events[eventIndex].t <= sample.t {
                writeEvent(events[eventIndex])
                eventIndex += 1
            }
            let ts = startTS + UInt32(max(0, sample.t.rounded()))
            if let last = lastRecordTS, ts <= last { continue } // FIT records need strictly increasing seconds
            lastRecordTS = ts
            w.write(global: 20, [
                .u32(253, Int(ts)),
                .u32(5, Int((sample.distance * 100).rounded())),
                .u16(6, sample.speed.map { Int(($0 * 1000).rounded()) }),
                .u16(7, sample.power),
                .u8(4, sample.cadence.map { Int($0.rounded()) }),
            ])
        }
        while eventIndex < events.count {
            writeEvent(events[eventIndex])
            eventIndex += 1
        }
        if events.last?.start ?? true {
            writeEvent((Double(endTS - startTS), false))
        }

        let elapsed = Int((s.elapsedTime * 1000).rounded())
        let timer = Int((s.timerTime * 1000).rounded())
        let moving = Int((s.movingTime * 1000).rounded())
        let distance = Int((s.distance * 100).rounded())
        let avgSpeed = Int((s.averageSpeed * 1000).rounded())
        let maxSpeed = Int((s.maxSpeed * 1000).rounded())
        let avgPower = s.averagePower.map { Int($0.rounded()) }
        let np = s.normalizedPower.map { Int($0.rounded()) }
        let avgCad = s.averageCadence.map { Int($0.rounded()) }
        let maxCad = s.maxCadence.map { Int($0.rounded()) }
        let kcal = Int(s.calories.rounded())
        let work = Int(s.work.rounded())

        // lap
        w.write(global: 19, [
            .u32(253, Int(endTS)), .enumeration(0, 9), .enumeration(1, 1), .u32(2, Int(startTS)),
            .u32(7, elapsed), .u32(8, timer), .u32(9, distance), .u16(11, kcal),
            .u16(13, avgSpeed), .u16(14, maxSpeed), .u8(17, avgCad), .u8(18, maxCad),
            .u16(19, avgPower), .u16(20, s.maxPower), .enumeration(24, 7), .enumeration(25, 2),
            .u16(33, np), .enumeration(39, 6), .u32(41, work), .u32(52, moving), .u16(254, 0),
        ])

        // session
        w.write(global: 18, [
            .u32(253, Int(endTS)), .enumeration(0, 8), .enumeration(1, 1), .u32(2, Int(startTS)),
            .enumeration(5, 2), .enumeration(6, 6), .u32(7, elapsed), .u32(8, timer), .u32(9, distance),
            .u16(11, kcal), .u16(14, avgSpeed), .u16(15, maxSpeed), .u8(18, avgCad), .u8(19, maxCad),
            .u16(20, avgPower), .u16(21, s.maxPower), .u16(25, 0), .u16(26, 1), .enumeration(28, 0),
            .u16(34, np), .u32(48, work), .u32(59, moving), .u16(254, 0),
        ])

        // activity
        let localTS = Int(endTS) + timeZone.secondsFromGMT(for: ride.end)
        w.write(global: 34, [
            .u32(253, Int(endTS)), .u32(0, timer), .u16(1, 1), .enumeration(2, 0),
            .enumeration(3, 26), .enumeration(4, 1), .u32(5, localTS),
        ])

        return w.finish()
    }

    static func serial(for id: UUID) -> UInt32 {
        let b = id.uuid
        let v = UInt32(b.0) << 24 | UInt32(b.1) << 16 | UInt32(b.2) << 8 | UInt32(b.3)
        return v == 0 ? 1 : v
    }

    // MARK: TCX

    public static func tcx(_ ride: ExportableRide) -> Data {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        let s = ride.record.summary
        var x = """
        <?xml version="1.0" encoding="UTF-8"?>
        <TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" \
        xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
          <Activities>
            <Activity Sport="Biking">
              <Id>\(iso.string(from: ride.start))</Id>
              <Lap StartTime="\(iso.string(from: ride.start))">
                <TotalTimeSeconds>\(fmt(s.timerTime, 1))</TotalTimeSeconds>
                <DistanceMeters>\(fmt(s.distance, 1))</DistanceMeters>
                <MaximumSpeed>\(fmt(s.maxSpeed, 3))</MaximumSpeed>
                <Calories>\(Int(s.calories.rounded()))</Calories>
                <Intensity>Active</Intensity>\n
        """
        if let c = s.averageCadence { x += "          <Cadence>\(Int(c.rounded()))</Cadence>\n" }
        x += """
                  <TriggerMethod>Manual</TriggerMethod>
                  <Track>\n
        """
        var lastSecond = -1
        for sample in ride.track.samples {
            let second = Int(sample.t.rounded())
            guard second > lastSecond else { continue }
            lastSecond = second
            x += "            <Trackpoint>\n"
            x += "              <Time>\(iso.string(from: ride.start.addingTimeInterval(Double(second))))</Time>\n"
            x += "              <DistanceMeters>\(fmt(sample.distance, 2))</DistanceMeters>\n"
            if let c = sample.cadence { x += "              <Cadence>\(min(254, Int(c.rounded())))</Cadence>\n" }
            if sample.speed != nil || sample.power != nil {
                x += "              <Extensions><ns3:TPX>"
                if let v = sample.speed { x += "<ns3:Speed>\(fmt(v, 3))</ns3:Speed>" }
                if let p = sample.power { x += "<ns3:Watts>\(p)</ns3:Watts>" }
                x += "</ns3:TPX></Extensions>\n"
            }
            x += "            </Trackpoint>\n"
        }
        x += """
                  </Track>
                </Lap>
                <Notes>Indoor trainer ride recorded with \(productName) (Kinetic inRide)</Notes>
                <Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Name>\(productName)</Name><UnitId>0</UnitId><ProductID>0</ProductID></Creator>
              </Activity>
            </Activities>
          </TrainingCenterDatabase>\n
        """
        return Data(x.utf8)
    }

    // MARK: CSV

    public static func csv(_ ride: ExportableRide) -> Data {
        var out = "elapsed_s,timestamp_utc,power_w,speed_kph,cadence_rpm,distance_m\n"
        let iso = ISO8601DateFormatter()
        for s in ride.track.samples {
            out += [
                fmt(s.t, 1),
                iso.string(from: ride.start.addingTimeInterval(s.t)),
                s.power.map(String.init) ?? "",
                s.speed.map { fmt($0 * 3.6, 2) } ?? "",
                s.cadence.map { fmt($0, 1) } ?? "",
                fmt(s.distance, 2),
            ].joined(separator: ",") + "\n"
        }
        return Data(out.utf8)
    }

    static func fmt(_ v: Double, _ places: Int) -> String {
        String(format: "%.\(places)f", locale: Locale(identifier: "en_US_POSIX"), v)
    }
}
