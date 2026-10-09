import Foundation

// What the phone shares with the server, mirroring `api/src/phone/phone-store.ts`. Pure: the
// readers in PhoneReaders.swift fill these from HealthKit, EventKit and Core Location. The
// sources and the envelope live in Core/Models.swift, which the share extension compiles too.

nonisolated struct HealthProfile: Encodable, Hashable, Sendable {
    var birthDate: String?
    var sex: String?
    var bloodType: String?
    var skinType: String?
    var wheelchair: Bool?

    var isEmpty: Bool { birthDate == nil && sex == nil && bloodType == nil && skinType == nil && wheelchair == nil }
}

/// A day of one quantity: its total ("sum"), or its average with the day's range ("average").
nonisolated struct HealthMetricDay: Encodable, Hashable, Sendable {
    var date: String
    var value: Double
    var min: Double?
    var max: Double?
}

nonisolated struct HealthMetric: Encodable, Hashable, Sendable {
    var type: String
    var name: String
    var unit: String
    var aggregation: String
    var days: [HealthMetricDay]
}

nonisolated struct HealthCategoryDay: Encodable, Hashable, Sendable {
    var date: String
    var count: Int
    var minutes: Double?
    var values: [String]?
}

nonisolated struct HealthCategory: Encodable, Hashable, Sendable {
    var type: String
    var name: String
    var days: [HealthCategoryDay]
}

/// One night, on the day it ended.
nonisolated struct SleepNight: Encodable, Hashable, Sendable {
    var date: String
    var asleepHours: Double
    var inBedHours: Double?
    var coreHours: Double?
    var deepHours: Double?
    var remHours: Double?
    var awakeHours: Double?
    var start: String?
    var end: String?
}

nonisolated struct HealthMood: Encodable, Hashable, Sendable {
    var at: String
    /// "momentary" or "daily".
    var kind: String
    var valence: Double
    var labels: [String]
    var associations: [String]
}

nonisolated struct HealthWorkout: Encodable, Hashable, Sendable {
    var type: String
    var start: String
    var minutes: Double
    var energyKcal: Double?
    var distanceKm: Double?
}

nonisolated struct HealthData: Encodable, Hashable, Sendable {
    var profile: HealthProfile?
    var metrics: [HealthMetric]
    var categories: [HealthCategory]
    var sleep: [SleepNight]
    var moods: [HealthMood]
    var workouts: [HealthWorkout]
}

/// Readable names for HealthKit's type identifiers: "HKQuantityTypeIdentifierDietaryVitaminB12"
/// becomes type "dietaryVitaminB12", named "Vitamin B12 (dietary)".
nonisolated enum HealthNames {
    /// The identifier without Apple's prefix, as the server stores it.
    static func type(_ identifier: String) -> String {
        var rest = identifier
        for prefix in ["HKQuantityTypeIdentifier", "HKCategoryTypeIdentifier"] where rest.hasPrefix(prefix) {
            rest = String(rest.dropFirst(prefix.count))
        }
        return rest.prefix(1).lowercased() + rest.dropFirst()
    }

    private static let names: [String: String] = [
        "stepCount": "Steps",
        "bodyMass": "Weight",
        "bodyMassIndex": "Body mass index",
        "leanBodyMass": "Lean body mass",
        "activeEnergyBurned": "Active energy",
        "basalEnergyBurned": "Resting energy",
        "appleExerciseTime": "Exercise minutes",
        "appleMoveTime": "Move minutes",
        "appleStandTime": "Stand minutes",
        "appleStandHour": "Stand hours",
        "heartRateVariabilitySDNN": "Heart rate variability (SDNN)",
        "vo2Max": "VO2 max",
        "oxygenSaturation": "Blood oxygen",
        "dietaryEnergyConsumed": "Calories eaten",
        "dietaryWater": "Water drunk",
        "appleSleepingWristTemperature": "Wrist temperature during sleep",
        "appleSleepingBreathingDisturbances": "Breathing disturbances during sleep",
        "appleWalkingSteadiness": "Walking steadiness",
        "appleWalkingSteadinessEvent": "Low walking steadiness",
        "forcedExpiratoryVolume1": "Forced expiratory volume (FEV1)",
        "uvExposure": "UV exposure",
        "mindfulSession": "Mindful minutes",
        "rapidPoundingOrFlutteringHeartbeat": "Rapid, pounding or fluttering heartbeat",
        "chestTightnessOrPain": "Chest tightness or pain",
        "atrialFibrillationBurden": "AFib history",
        "highHeartRateEvent": "High heart rate notification",
        "lowHeartRateEvent": "Low heart rate notification",
        "irregularHeartRhythmEvent": "Irregular rhythm notification",
        "lowCardioFitnessEvent": "Low cardio fitness notification",
        "hypertensionEvent": "Hypertension notification",
        "sleepApneaEvent": "Breathing disturbance notification",
        "environmentalAudioExposure": "Environmental sound levels",
        "headphoneAudioExposure": "Headphone audio levels",
        "headphoneAudioExposureEvent": "Loud headphone audio notification",
    ]

    static func name(_ type: String) -> String {
        if let name = names[type] { return name }
        // "dietaryVitaminB12" → "Vitamin B12 (dietary)"; other camel case reads as words.
        if type.hasPrefix("dietary"), type.count > 7 {
            return "\(words(String(type.dropFirst(7)))) (dietary)"
        }
        return words(type)
    }

    private static func words(_ camel: String) -> String {
        var out = ""
        let chars = Array(camel)
        for (i, c) in chars.enumerated() {
            let previous = i > 0 ? chars[i - 1] : nil
            let next = i + 1 < chars.count ? chars[i + 1] : nil
            // A new word at a capital after a lower-case letter, or the last capital of a run
            // followed by lower case ("SDNNValue"); digits stay with what they follow ("B12").
            let breaks = c.isUppercase && previous != nil && (previous!.isLowercase || (previous!.isUppercase && next?.isLowercase == true))
            if breaks { out.append(" ") }
            out.append(c)
        }
        // Lower-case the words after the first, except runs of capitals ("SDNN", "B12" keeps "B").
        let parts = out.split(separator: " ").enumerated().map { index, word -> String in
            let upper = word.filter(\.isUppercase).count
            if index == 0 { return word.prefix(1).uppercased() + word.dropFirst() }
            return upper > 1 || word.contains(where: \.isNumber) ? String(word) : word.lowercased()
        }
        return parts.joined(separator: " ")
    }
}

/// What a category sample's value means, for the types where it says more than "it happened".
/// Keyed by the type as `HealthNames.type` gives it; values as HealthKit numbers them.
nonisolated enum HealthCategoryValues {
    static let symptoms: Set<String> = [
        "abdominalCramps", "acne", "bladderIncontinence", "bloating", "breastPain", "chestTightnessOrPain", "chills",
        "constipation", "coughing", "diarrhea", "dizziness", "drySkin", "fainting", "fatigue", "fever", "generalizedBodyAche",
        "hairLoss", "headache", "heartburn", "hotFlashes", "lossOfSmell", "lossOfTaste", "lowerBackPain", "memoryLapse",
        "nausea", "nightSweats", "pelvicPain", "rapidPoundingOrFlutteringHeartbeat", "runnyNose", "shortnessOfBreath",
        "sinusCongestion", "skippedHeartbeat", "soreThroat", "vaginalDryness", "vomiting", "wheezing",
    ]

    static func label(type: String, value: Int) -> String? {
        if symptoms.contains(type) {
            return [0: "present", 1: "not present", 2: "mild", 3: "moderate", 4: "severe"][value]
        }
        switch type {
        case "menstrualFlow", "intermenstrualBleeding", "bleedingDuringPregnancy", "bleedingAfterPregnancy":
            return [1: "unspecified", 2: "light", 3: "medium", 4: "heavy", 5: "none"][value]
        case "ovulationTestResult":
            return [1: "negative", 2: "LH surge", 3: "indeterminate", 4: "estrogen surge"][value]
        case "pregnancyTestResult", "progesteroneTestResult":
            return [1: "negative", 2: "positive", 3: "indeterminate"][value]
        case "cervicalMucusQuality":
            return [1: "dry", 2: "sticky", 3: "creamy", 4: "watery", 5: "egg white"][value]
        case "contraceptive":
            return [1: "unspecified", 2: "implant", 3: "injection", 4: "IUD", 5: "vaginal ring", 6: "pill", 7: "patch"][value]
        case "appetiteChanges":
            return [0: "unspecified", 1: "no change", 2: "decreased", 3: "increased"][value]
        case "moodChanges", "sleepChanges":
            return [0: "present", 1: "not present"][value]
        case "appleWalkingSteadinessEvent":
            return [1: "low", 2: "very low", 3: "low again", 4: "very low again"][value]
        default:
            return nil
        }
    }
}

nonisolated struct CalendarEventData: Encodable, Hashable, Sendable {
    var title: String
    var start: String
    var end: String?
    var allDay: Bool
    var location: String?
    var calendar: String?
    var notes: String?
}

nonisolated struct CalendarData: Encodable, Hashable, Sendable {
    var events: [CalendarEventData]
}

nonisolated struct ReminderData: Encodable, Hashable, Sendable {
    var title: String
    var due: String?
    var allDay: Bool?
    var list: String?
    var priority: Int?
    var notes: String?
}

nonisolated struct RemindersData: Encodable, Hashable, Sendable {
    var items: [ReminderData]
}

nonisolated struct LocationData: Encodable, Hashable, Sendable {
    var place: String
    var region: String?
    var country: String?
    var latitude: Double?
    var longitude: Double?
}

nonisolated struct LabelledValue: Encodable, Hashable, Sendable {
    var label: String?
    var value: String
}

nonisolated struct ContactRelation: Encodable, Hashable, Sendable {
    var label: String
    var name: String
}

nonisolated struct ContactData: Encodable, Hashable, Sendable {
    var name: String
    var nickname: String?
    var organization: String?
    var jobTitle: String?
    var phones: [LabelledValue]
    var emails: [LabelledValue]
    var birthday: String?
    var relations: [ContactRelation]
    var city: String?
}

nonisolated struct ContactsData: Encodable, Hashable, Sendable {
    var contacts: [ContactData]
}

/// One stay, as iOS reports it and as it is kept on the phone until it is sent.
nonisolated struct VisitRecord: Codable, Hashable, Sendable {
    var arrival: Date
    var departure: Date?
    var latitude: Double
    var longitude: Double
    var place: String?
}

nonisolated struct VisitData: Encodable, Hashable, Sendable {
    var arrival: String
    var departure: String?
    var place: String?
    var latitude: Double
    var longitude: Double
}

nonisolated struct PlacesData: Encodable, Hashable, Sendable {
    var visits: [VisitData]
}

nonisolated enum PlaceLog {
    /// How long stays are kept on the phone.
    static let keep: TimeInterval = 30 * 86_400

    /// Adds a stay. iOS reports a visit twice — on arrival without a departure, and again when it
    /// ends — so a report for a known arrival at the same spot replaces it, keeping its name.
    static func adding(_ visit: VisitRecord, to log: [VisitRecord], now: Date = .now) -> [VisitRecord] {
        var log = log.filter { now.timeIntervalSince($0.departure ?? $0.arrival) < keep }
        if let i = log.firstIndex(where: { abs($0.arrival.timeIntervalSince(visit.arrival)) < 60 && abs($0.latitude - visit.latitude) < 0.002 && abs($0.longitude - visit.longitude) < 0.002 }) {
            var merged = visit
            merged.place = visit.place ?? log[i].place
            log[i] = merged
        } else {
            log.append(visit)
        }
        return Array(log.sorted { $0.arrival > $1.arrival }.prefix(1000))
    }

    static func data(_ log: [VisitRecord]) -> PlacesData {
        PlacesData(visits: log.map {
            VisitData(arrival: $0.arrival.ISO8601Format(), departure: $0.departure?.ISO8601Format(),
                      place: PhoneText.clip($0.place, max: 200),
                      latitude: PhoneText.round($0.latitude, digits: 4) ?? $0.latitude,
                      longitude: PhoneText.round($0.longitude, digits: 4) ?? $0.longitude)
        })
    }
}

nonisolated struct SongData: Encodable, Hashable, Sendable {
    var title: String
    var artist: String?
    var album: String?
    var genre: String?
    var plays: Int?
    var lastPlayed: String?
}

nonisolated struct PlayTally: Encodable, Hashable, Sendable {
    var name: String
    var plays: Int
}

nonisolated struct MusicData: Encodable, Hashable, Sendable {
    var recent: [SongData]
    var top: [SongData]
    var artists: [PlayTally]
    var genres: [PlayTally]
}

/// A song in the library, as the reader finds it.
nonisolated struct SongStat: Hashable, Sendable {
    var title: String
    var artist: String?
    var album: String?
    var genre: String?
    var plays: Int
    var lastPlayed: Date?
}

nonisolated enum MusicSummary {
    /// The library in a few lists: played lately (the last month), played most, and the artists
    /// and genres those plays add up to.
    static func make(_ songs: [SongStat], now: Date = .now) -> MusicData {
        func data(_ s: SongStat) -> SongData {
            SongData(title: PhoneText.clip(s.title, max: 200) ?? "Untitled", artist: PhoneText.clip(s.artist, max: 200),
                     album: PhoneText.clip(s.album, max: 200), genre: PhoneText.clip(s.genre, max: 100),
                     plays: s.plays, lastPlayed: s.lastPlayed?.ISO8601Format())
        }
        func tally(_ key: (SongStat) -> String?, limit: Int) -> [PlayTally] {
            var plays: [String: Int] = [:]
            for song in songs where song.plays > 0 {
                if let name = PhoneText.clip(key(song), max: 200) { plays[name, default: 0] += song.plays }
            }
            return plays.map { PlayTally(name: $0.key, plays: $0.value) }
                .sorted { $0.plays != $1.plays ? $0.plays > $1.plays : $0.name < $1.name }
                .prefix(limit).map { $0 }
        }
        let recent = songs.filter { ($0.lastPlayed.map { now.timeIntervalSince($0) < 30 * 86_400 }) ?? false }
            .sorted { ($0.lastPlayed ?? .distantPast) > ($1.lastPlayed ?? .distantPast) }
        let top = songs.filter { $0.plays > 0 }.sorted { $0.plays > $1.plays }
        return MusicData(recent: recent.prefix(50).map(data), top: top.prefix(50).map(data),
                         artists: tally(\.artist, limit: 50), genres: tally(\.genre, limit: 30))
    }
}

nonisolated struct PhotoDayData: Encodable, Hashable, Sendable {
    var date: String
    var photos: Int
    var videos: Int
    var favorites: Int
    var places: [String]
}

nonisolated struct PhotosData: Encodable, Hashable, Sendable {
    var total: Int
    var days: [PhotoDayData]
}

/// A picture's metadata, as the reader finds it. Never its pixels.
nonisolated struct PhotoStat: Hashable, Sendable {
    var date: Date
    var isVideo: Bool
    var isFavorite: Bool
    var cell: String?
}

nonisolated enum PhotoSummary {
    /// The square of about 10 km a picture was taken in, so a town is named once, not per photo.
    static func cell(latitude: Double, longitude: Double) -> String {
        String(format: "%.1f,%.1f", (latitude * 10).rounded() / 10, (longitude * 10).rounded() / 10)
    }

    /// Cells with the most pictures first: the ones worth naming when names are rationed.
    static func cellsByCount(_ stats: [PhotoStat]) -> [String] {
        var counts: [String: Int] = [:]
        for stat in stats { if let cell = stat.cell { counts[cell, default: 0] += 1 } }
        return counts.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map(\.key)
    }

    /// One line per day with pictures, newest first, with the places named so far.
    static func days(_ stats: [PhotoStat], names: [String: String], calendar: Calendar = .current) -> [PhotoDayData] {
        var days: [String: PhotoDayData] = [:]
        for stat in stats {
            let date = PhoneText.day(stat.date, calendar: calendar)
            var day = days[date] ?? PhotoDayData(date: date, photos: 0, videos: 0, favorites: 0, places: [])
            if stat.isVideo { day.videos += 1 } else { day.photos += 1 }
            if stat.isFavorite { day.favorites += 1 }
            if let name = stat.cell.flatMap({ names[$0] }), !day.places.contains(name), day.places.count < 10 {
                day.places.append(name)
            }
            days[date] = day
        }
        return days.values.sorted { $0.date > $1.date }.prefix(400).map { $0 }
    }
}

nonisolated enum PhoneText {
    /// Trimmed, nil when empty, and at most `max` UTF-16 units (how the server counts).
    static func clip(_ text: String?, max: Int) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        guard trimmed.utf16.count > max else { return trimmed }
        var out = ""
        for character in trimmed {
            if out.utf16.count + String(character).utf16.count > max - 1 { break }
            out.append(character)
        }
        return out + "…"
    }

    /// A birthday as the server takes it: "YYYY-MM-DD", or "--MM-DD" without a year.
    static func birthday(_ c: DateComponents?) -> String? {
        guard let month = c?.month, let day = c?.day, (1...12).contains(month), (1...31).contains(day) else { return nil }
        guard let year = c?.year, year > 0, year != NSDateComponentUndefined else { return String(format: "--%02d-%02d", month, day) }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// "YYYY-MM-DD" of `date` on `calendar`.
    static func day(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Rounded for sending: enough digits to be useful, none that only add noise.
    static func round(_ value: Double?, digits: Int = 1) -> Double? {
        guard let value, value.isFinite else { return nil }
        let scale = pow(10, Double(digits))
        return (value * scale).rounded() / scale
    }

    /// Rounded to `digits` significant digits, but never past the whole number: 0.04567 blood alcohol, 12,346 steps.
    static func significant(_ value: Double, digits: Int = 4) -> Double? {
        guard value.isFinite else { return nil }
        guard value != 0 else { return 0 }
        let places = max(0, digits - 1 - Int(floor(log10(abs(value)))))
        return round(value, digits: places)
    }
}

nonisolated enum SleepStage: Hashable, Sendable {
    case inBed, asleep, core, deep, rem, awake
}

nonisolated enum SleepTotals {
    /// Nights from Health's sleep records, each on the day it ended (a night belongs to the
    /// morning after). Overlapping records of one stage — a watch and the phone both logging the
    /// night — count once; "asleep" is the union of every sleeping stage.
    static func nights(_ samples: [(interval: DateInterval, stage: SleepStage)], calendar: Calendar = .current) -> [SleepNight] {
        func merged(_ intervals: [DateInterval]) -> [DateInterval] {
            var out: [DateInterval] = []
            for interval in intervals.sorted(by: { $0.start < $1.start }) {
                if let last = out.last, interval.start <= last.end {
                    out[out.count - 1] = DateInterval(start: last.start, end: max(last.end, interval.end))
                } else {
                    out.append(interval)
                }
            }
            return out
        }
        let sleeping: Set<SleepStage> = [.asleep, .core, .deep, .rem]
        var nights: [String: SleepNight] = [:]
        var bounds: [String: DateInterval] = [:]
        for block in merged(samples.filter { sleeping.contains($0.stage) }.map(\.interval)) {
            let day = PhoneText.day(block.end, calendar: calendar)
            nights[day, default: SleepNight(date: day, asleepHours: 0)].asleepHours += block.duration / 3600
            bounds[day] = bounds[day].map { DateInterval(start: min($0.start, block.start), end: max($0.end, block.end)) } ?? block
        }
        let stages: [(SleepStage, WritableKeyPath<SleepNight, Double?>)] = [
            (.inBed, \.inBedHours), (.core, \.coreHours), (.deep, \.deepHours), (.rem, \.remHours), (.awake, \.awakeHours),
        ]
        for (stage, keyPath) in stages {
            for block in merged(samples.filter { $0.stage == stage }.map(\.interval)) {
                let day = PhoneText.day(block.end, calendar: calendar)
                guard nights[day] != nil else { continue }
                nights[day]![keyPath: keyPath] = (nights[day]![keyPath: keyPath] ?? 0) + block.duration / 3600
            }
        }
        return nights.values.map { night in
            var night = night
            night.asleepHours = PhoneText.round(night.asleepHours, digits: 2) ?? 0
            for (_, keyPath) in stages { night[keyPath: keyPath] = PhoneText.round(night[keyPath: keyPath], digits: 2) }
            night.start = bounds[night.date]?.start.ISO8601Format()
            night.end = bounds[night.date]?.end.ISO8601Format()
            return night
        }
        .sorted { $0.date > $1.date }
    }
}

nonisolated enum PhoneSchedule {
    /// How long a sent snapshot is fresh enough not to send again on the next foreground. Health
    /// is the heaviest to read and send, and changes by the hour rather than the minute.
    static func interval(for source: PhoneSource) -> TimeInterval {
        switch source {
        case .health: 60 * 60
        // Change slowly, and are the most work to read.
        case .contacts, .music, .photos: 6 * 60 * 60
        case .calendar, .reminders, .location, .places: 30 * 60
        }
    }

    static func isDue(_ source: PhoneSource, lastSent: Date?, now: Date = .now) -> Bool {
        guard let lastSent else { return true }
        return now.timeIntervalSince(lastSent) >= interval(for: source) || lastSent > now
    }
}
