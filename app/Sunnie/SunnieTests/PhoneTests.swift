import Foundation
import Testing
@testable import Sunnie

struct PhoneTests {
    private let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Jakarta")!
        return c
    }()

    private func at(_ iso: String) -> Date { ISO8601.parse(iso)! }

    @Test func textIsTrimmedAndClippedTheWayTheServerCounts() {
        #expect(PhoneText.clip("  Dentist \n", max: 200) == "Dentist")
        #expect(PhoneText.clip("   ", max: 200) == nil, "an empty title is left out, not sent as blank")
        #expect(PhoneText.clip(nil, max: 10) == nil)
        let clipped = PhoneText.clip(String(repeating: "😀", count: 10), max: 7)!
        #expect(clipped.utf16.count <= 7 && clipped.hasSuffix("…"), "emoji are two UTF-16 units, as in JavaScript")
    }

    @Test func figuresAreRoundedToWhatIsUseful() {
        #expect(PhoneText.significant(12_345.678) == 12_346, "whole numbers stay whole")
        #expect(PhoneText.significant(0.04567) == 0.04567)
        #expect(PhoneText.significant(97.123) == 97.12)
        #expect(PhoneText.significant(0) == 0)
        #expect(PhoneText.significant(.nan) == nil)
        #expect(PhoneText.round(6.756, digits: 2) == 6.76)
        #expect(PhoneText.day(at("2026-10-04T18:30:00Z"), calendar: utc) == "2026-10-05", "the day is the phone's")
    }

    @Test func healthTypesGetReadableNames() {
        #expect(HealthNames.type("HKQuantityTypeIdentifierDietaryVitaminB12") == "dietaryVitaminB12")
        #expect(HealthNames.type("HKCategoryTypeIdentifierHeadache") == "headache")
        #expect(HealthNames.name("dietaryVitaminB12") == "Vitamin B12 (dietary)")
        #expect(HealthNames.name("heartRateRecoveryOneMinute") == "Heart rate recovery one minute")
        #expect(HealthNames.name("bloodPressureSystolic") == "Blood pressure systolic")
        #expect(HealthNames.name("stepCount") == "Steps")
        #expect(HealthNames.name("vo2Max") == "VO2 max")
        #expect(HealthNames.name("someTypeAppleAddsNextYear") == "Some type apple adds next year")
    }

    @Test func categoryValuesSayWhatTheyMean() {
        #expect(HealthCategoryValues.label(type: "headache", value: 3) == "moderate")
        #expect(HealthCategoryValues.label(type: "menstrualFlow", value: 4) == "heavy")
        #expect(HealthCategoryValues.label(type: "mindfulSession", value: 0) == nil, "a session is just a session")
        #expect(HealthCategoryValues.label(type: "headache", value: 42) == nil)
    }

    @Test func sleepIsCountedOncePerNightByStage() {
        // The watch logs stages, the phone logs "asleep" over the same night: the union counts once.
        let samples: [(interval: DateInterval, stage: SleepStage)] = [
            (DateInterval(start: at("2026-10-04T16:30:00Z"), end: at("2026-10-05T00:00:00Z")), .inBed),
            (DateInterval(start: at("2026-10-04T17:00:00Z"), end: at("2026-10-04T20:00:00Z")), .core),
            (DateInterval(start: at("2026-10-04T20:00:00Z"), end: at("2026-10-04T21:00:00Z")), .deep),
            (DateInterval(start: at("2026-10-04T21:00:00Z"), end: at("2026-10-04T21:15:00Z")), .awake),
            (DateInterval(start: at("2026-10-04T21:15:00Z"), end: at("2026-10-04T23:45:00Z")), .rem),
            (DateInterval(start: at("2026-10-04T17:00:00Z"), end: at("2026-10-04T23:45:00Z")), .asleep),
            // An afternoon nap two days earlier.
            (DateInterval(start: at("2026-10-03T07:00:00Z"), end: at("2026-10-03T07:30:00Z")), .asleep),
        ]
        let nights = SleepTotals.nights(samples, calendar: utc)
        #expect(nights.map(\.date) == ["2026-10-05", "2026-10-03"], "a night belongs to its morning, newest first")
        let night = nights[0]
        #expect(night.asleepHours == 6.75 && night.inBedHours == 7.5)
        #expect(night.coreHours == 3 && night.deepHours == 1 && night.remHours == 2.5 && night.awakeHours == 0.25)
        #expect(night.start == "2026-10-04T17:00:00Z" && night.end == "2026-10-04T23:45:00Z")
        #expect(nights[1].asleepHours == 0.5 && nights[1].inBedHours == nil)
    }

    @Test func aSourceIsSentAgainOnlyOnceItHasGoneStale() {
        let now = Date.now
        #expect(PhoneSchedule.isDue(.calendar, lastSent: nil, now: now))
        #expect(!PhoneSchedule.isDue(.calendar, lastSent: now.addingTimeInterval(-10 * 60), now: now))
        #expect(PhoneSchedule.isDue(.calendar, lastSent: now.addingTimeInterval(-31 * 60), now: now))
        #expect(!PhoneSchedule.isDue(.health, lastSent: now.addingTimeInterval(-31 * 60), now: now), "Health is heavier: hourly")
        #expect(PhoneSchedule.isDue(.health, lastSent: now.addingTimeInterval(3600), now: now), "a clock that went back")
    }

    @Test func aSnapshotIsSentInTheServersShape() throws {
        let health = HealthData(
            profile: HealthProfile(birthDate: "1990-04-02", sex: "female"),
            metrics: [HealthMetric(type: "stepCount", name: "Steps", unit: "count", aggregation: "sum",
                                   days: [HealthMetricDay(date: "2026-10-05", value: 1200)])],
            categories: [HealthCategory(type: "headache", name: "Headache", days: [HealthCategoryDay(date: "2026-10-03", count: 2, values: ["moderate"])])],
            sleep: [], moods: [HealthMood(at: "2026-10-04T13:00:00Z", kind: "daily", valence: 0.4, labels: ["calm"], associations: ["work"])],
            workouts: [])
        let data = try JSONEncoder().encode(PhoneSnapshot(capturedAt: "2026-10-05T01:55:00Z", timeZone: "Asia/Jakarta", data: health))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["capturedAt"] as? String == "2026-10-05T01:55:00Z" && json["timeZone"] as? String == "Asia/Jakarta")
        let body = try #require(json["data"] as? [String: Any])
        let metric = try #require((body["metrics"] as? [[String: Any]])?.first)
        #expect(metric["aggregation"] as? String == "sum" && (metric["days"] as? [[String: Any]])?.first?["min"] == nil, "nil is left out, not null")
        #expect((body["profile"] as? [String: Any])?["birthDate"] as? String == "1990-04-02")

        let status = try JSONDecoder().decode(PhoneSourceList.self, from: Data(#"{"sources":[{"source":"health","capturedAt":"2026-10-05T01:55:00.000Z","updatedAt":"2026-10-05T01:55:01.000Z","count":14}]}"#.utf8))
        #expect(status.sources.first?.count == 14 && status.sources.first?.capturedDate != nil)
    }

    @Test func birthdaysAreSentWithOrWithoutAYear() {
        #expect(PhoneText.birthday(DateComponents(year: 1965, month: 10, day: 7)) == "1965-10-07")
        #expect(PhoneText.birthday(DateComponents(month: 11, day: 20)) == "--11-20")
        #expect(PhoneText.birthday(DateComponents(year: 1990)) == nil)
        #expect(PhoneText.birthday(nil) == nil)
    }

    @Test func aVisitReportedTwiceIsKeptOnce() {
        let now = at("2026-10-05T12:00:00Z")
        let arrived = VisitRecord(arrival: at("2026-10-05T01:10:00Z"), departure: nil, latitude: -6.91471, longitude: 107.60981)
        var log = PlaceLog.adding(arrived, to: [], now: now)
        log[0].place = "Kopi Tuku"
        let left = VisitRecord(arrival: at("2026-10-05T01:10:20Z"), departure: at("2026-10-05T02:40:00Z"), latitude: -6.9148, longitude: 107.6097)
        log = PlaceLog.adding(left, to: log, now: now)
        #expect(log.count == 1 && log[0].departure == at("2026-10-05T02:40:00Z") && log[0].place == "Kopi Tuku", "the end of a stay replaces its start and keeps its name")
        let old = VisitRecord(arrival: at("2026-08-01T01:00:00Z"), departure: at("2026-08-01T02:00:00Z"), latitude: 0, longitude: 0)
        log = PlaceLog.adding(VisitRecord(arrival: at("2026-10-05T03:00:00Z"), latitude: -6.9, longitude: 107.6), to: log + [old], now: now)
        #expect(log.map(\.arrival) == [at("2026-10-05T03:00:00Z"), at("2026-10-05T01:10:20Z")], "newest first, a month is kept, and the later report of a stay wins")
        let sent = PlaceLog.data(log).visits[1]
        #expect(sent.latitude == -6.9148 && sent.place == "Kopi Tuku" && sent.departure == "2026-10-05T02:40:00Z")
    }

    @Test func musicIsSummedUpIntoWhatIsPlayed() {
        let now = at("2026-10-05T12:00:00Z")
        let songs = [
            SongStat(title: "Something", artist: "The Beatles", genre: "Rock", plays: 42, lastPlayed: at("2026-06-01T00:00:00Z")),
            SongStat(title: "Here Comes the Sun", artist: "The Beatles", genre: "Rock", plays: 10, lastPlayed: at("2026-10-04T12:00:00Z")),
            SongStat(title: "Bloom", artist: "Lomba Sihir", genre: "Indie", plays: 12, lastPlayed: at("2026-10-05T08:00:00Z")),
            SongStat(title: "Never played", artist: "Nobody", plays: 0, lastPlayed: nil),
        ]
        let music = MusicSummary.make(songs, now: now)
        #expect(music.recent.map(\.title) == ["Bloom", "Here Comes the Sun"], "the last month, latest first")
        #expect(music.top.map(\.title) == ["Something", "Bloom", "Here Comes the Sun"])
        #expect(music.artists == [PlayTally(name: "The Beatles", plays: 52), PlayTally(name: "Lomba Sihir", plays: 12)])
        #expect(music.genres.first == PlayTally(name: "Rock", plays: 52))
    }

    @Test func photosAreCountedPerDayWithTheirPlaces() {
        let bali = PhotoSummary.cell(latitude: -8.5069, longitude: 115.2625)
        #expect(bali == "-8.5,115.3")
        let stats = [
            PhotoStat(date: at("2026-03-14T02:00:00Z"), isVideo: false, isFavorite: true, cell: bali),
            PhotoStat(date: at("2026-03-14T05:00:00Z"), isVideo: true, isFavorite: false, cell: bali),
            PhotoStat(date: at("2026-03-14T06:00:00Z"), isVideo: false, isFavorite: false, cell: "-8.7,115.2"),
            PhotoStat(date: at("2026-10-04T18:30:00Z"), isVideo: false, isFavorite: false, cell: nil),
        ]
        #expect(PhotoSummary.cellsByCount(stats) == [bali, "-8.7,115.2"], "the most photographed place is named first")
        let days = PhotoSummary.days(stats, names: [bali: "Ubud, Bali"], calendar: utc)
        #expect(days.map(\.date) == ["2026-10-05", "2026-03-14"], "a day is the phone's day")
        #expect(days[1] == PhotoDayData(date: "2026-03-14", photos: 2, videos: 1, favorites: 1, places: ["Ubud, Bali"]), "a place without a name yet is left out")
    }

    @Test func slowSourcesAreSentLessOften() {
        let now = Date.now
        #expect(!PhoneSchedule.isDue(.photos, lastSent: now.addingTimeInterval(-2 * 3600), now: now))
        #expect(PhoneSchedule.isDue(.photos, lastSent: now.addingTimeInterval(-7 * 3600), now: now))
        #expect(PhoneSchedule.isDue(.places, lastSent: now.addingTimeInterval(-31 * 60), now: now))
    }

    @Test func aShortcutGetsTheAnswerInWordsSiriCanSay() {
        #expect(ShortcutAnswer.title(for: "Remind me to stretch\nevery hour") == "Remind me to stretch")
        let messages = [
            Message(id: "m1", conversationId: "c", seq: 1, role: .user, text: "Hi", origin: nil, parts: [], model: nil, runId: "r1", createdAt: "2026-10-05T00:00:00Z"),
            Message(id: "m2", conversationId: "c", seq: 2, role: .assistant, text: "", origin: nil, parts: [], model: nil, runId: "r1", createdAt: "2026-10-05T00:00:01Z"),
            Message(id: "m3", conversationId: "c", seq: 3, role: .assistant, text: "**Done.**\n\n```event\ntitle: Stretch\n```\n- every hour", origin: nil, parts: [], model: nil, runId: "r1", createdAt: "2026-10-05T00:00:02Z"),
        ]
        let reply = ShortcutAnswer.reply(in: messages, run: "r1")
        #expect(reply == messages[2].text)
        #expect(ShortcutAnswer.spoken(reply!) == "Done. every hour", "cards and Markdown marks are not read out")
        #expect(ShortcutAnswer.spoken("") == "Done. The answer is in the chat.")
        #expect(ShortcutAnswer.spoken(String(repeating: "a", count: 500)).count == 400)
    }
}

