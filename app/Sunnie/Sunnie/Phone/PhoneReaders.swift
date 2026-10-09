import CoreLocation
import EventKit
import Foundation
import HealthKit
import MapKit

// Reading the phone's own records. Each reader asks for permission once (iOS remembers the
// answer) and returns what PhoneData.swift sends; a denied permission reads as nothing.

nonisolated enum PhoneReadError: LocalizedError {
    case unavailable(String)
    case denied(String)
    case timedOut

    var errorDescription: String? {
        switch self {
        case .unavailable(let what): "\(what) is not available on this device."
        case .denied(let what): "Sunnie isn’t allowed to read \(what). You can allow it in the Settings app."
        case .timedOut: "Your location could not be found in time."
        }
    }
}

enum HealthReader {
    private static let store = HKHealthStore()

    /// Every quantity HealthKit has on iOS 26 (generated from the SDK's HKTypeIdentifiers.h).
    private static let quantities: [HKQuantityTypeIdentifier] = [
        .appleSleepingWristTemperature, .bodyFatPercentage, .bodyMass, .bodyMassIndex, .electrodermalActivity,
        .height, .leanBodyMass, .waistCircumference, .activeEnergyBurned, .appleExerciseTime, .appleMoveTime,
        .appleStandTime, .basalEnergyBurned, .crossCountrySkiingSpeed, .cyclingCadence,
        .cyclingFunctionalThresholdPower, .cyclingPower, .cyclingSpeed, .distanceCrossCountrySkiing,
        .distanceCycling, .distanceDownhillSnowSports, .distancePaddleSports, .distanceRowing,
        .distanceSkatingSports, .distanceSwimming, .distanceWalkingRunning, .distanceWheelchair,
        .estimatedWorkoutEffortScore, .flightsClimbed, .nikeFuel, .paddleSportsSpeed, .physicalEffort, .pushCount,
        .rowingSpeed, .runningPower, .runningSpeed, .stepCount, .swimmingStrokeCount, .underwaterDepth,
        .workoutEffortScore, .environmentalAudioExposure, .environmentalSoundReduction, .headphoneAudioExposure,
        .atrialFibrillationBurden, .heartRate, .heartRateRecoveryOneMinute, .heartRateVariabilitySDNN,
        .peripheralPerfusionIndex, .restingHeartRate, .vo2Max, .walkingHeartRateAverage, .appleWalkingSteadiness,
        .runningGroundContactTime, .runningStrideLength, .runningVerticalOscillation, .sixMinuteWalkTestDistance,
        .stairAscentSpeed, .stairDescentSpeed, .walkingAsymmetryPercentage, .walkingDoubleSupportPercentage,
        .walkingSpeed, .walkingStepLength, .dietaryBiotin, .dietaryCaffeine, .dietaryCalcium, .dietaryCarbohydrates,
        .dietaryChloride, .dietaryCholesterol, .dietaryChromium, .dietaryCopper, .dietaryEnergyConsumed,
        .dietaryFatMonounsaturated, .dietaryFatPolyunsaturated, .dietaryFatSaturated, .dietaryFatTotal,
        .dietaryFiber, .dietaryFolate, .dietaryIodine, .dietaryIron, .dietaryMagnesium, .dietaryManganese,
        .dietaryMolybdenum, .dietaryNiacin, .dietaryPantothenicAcid, .dietaryPhosphorus, .dietaryPotassium,
        .dietaryProtein, .dietaryRiboflavin, .dietarySelenium, .dietarySodium, .dietarySugar, .dietaryThiamin,
        .dietaryVitaminA, .dietaryVitaminB12, .dietaryVitaminB6, .dietaryVitaminC, .dietaryVitaminD,
        .dietaryVitaminE, .dietaryVitaminK, .dietaryWater, .dietaryZinc, .bloodAlcoholContent,
        .bloodPressureDiastolic, .bloodPressureSystolic, .insulinDelivery, .numberOfAlcoholicBeverages,
        .numberOfTimesFallen, .timeInDaylight, .uvExposure, .waterTemperature, .basalBodyTemperature,
        .appleSleepingBreathingDisturbances, .forcedExpiratoryVolume1, .forcedVitalCapacity, .inhalerUsage,
        .oxygenSaturation, .peakExpiratoryFlowRate, .respiratoryRate, .bloodGlucose, .bodyTemperature,
    ]

    /// Every category but sleep, which is read on its own (generated the same way); newer ones
    /// only where the system has them.
    private static var categories: [HKCategoryTypeIdentifier] {
        if #available(iOS 26.2, macOS 26.2, *) { return baseCategories + [.hypertensionEvent] }
        return baseCategories
    }

    private static let baseCategories: [HKCategoryTypeIdentifier] = [
        .appleStandHour, .headphoneAudioExposureEvent, .highHeartRateEvent,
        .irregularHeartRhythmEvent, .lowCardioFitnessEvent, .lowHeartRateEvent, .mindfulSession,
        .appleWalkingSteadinessEvent, .handwashingEvent, .toothbrushingEvent, .bleedingAfterPregnancy,
        .bleedingDuringPregnancy, .cervicalMucusQuality, .contraceptive, .infrequentMenstrualCycles,
        .intermenstrualBleeding, .irregularMenstrualCycles, .lactation, .menstrualFlow, .ovulationTestResult,
        .persistentIntermenstrualBleeding, .pregnancy, .pregnancyTestResult, .progesteroneTestResult,
        .prolongedMenstrualPeriods, .sexualActivity, .sleepApneaEvent, .abdominalCramps, .acne, .appetiteChanges,
        .bladderIncontinence, .bloating, .breastPain, .chestTightnessOrPain, .chills, .constipation, .coughing,
        .diarrhea, .dizziness, .drySkin, .fainting, .fatigue, .fever, .generalizedBodyAche, .hairLoss, .headache,
        .heartburn, .hotFlashes, .lossOfSmell, .lossOfTaste, .lowerBackPain, .memoryLapse, .moodChanges, .nausea,
        .nightSweats, .pelvicPain, .rapidPoundingOrFlutteringHeartbeat, .runnyNose, .shortnessOfBreath,
        .sinusCongestion, .skippedHeartbeat, .sleepChanges, .soreThroat, .vaginalDryness, .vomiting, .wheezing,
    ]

    private static let characteristics: [HKCharacteristicTypeIdentifier] = [
        .dateOfBirth, .biologicalSex, .bloodType, .fitzpatrickSkinType, .wheelchairUse,
    ]

    private static var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [HKCategoryType(.sleepAnalysis), HKObjectType.workoutType(), HKObjectType.stateOfMindType()]
        types.formUnion(quantities.map { HKQuantityType($0) })
        types.formUnion(categories.map { HKCategoryType($0) })
        types.formUnion(characteristics.map { HKCharacteristicType($0) })
        return types
    }

    /// Types whose new samples wake the app, so Health does not go stale between opens: the ones
    /// that change through the day. Any of them changing sends all of Health (at most hourly).
    private nonisolated static func watchedTypes() -> [HKSampleType] {
        [HKQuantityType(.stepCount), HKQuantityType(.activeEnergyBurned), HKQuantityType(.appleExerciseTime),
         HKQuantityType(.heartRate), HKQuantityType(.restingHeartRate), HKQuantityType(.bodyMass),
         HKQuantityType(.dietaryEnergyConsumed), HKCategoryType(.sleepAnalysis), HKCategoryType(.mindfulSession),
         HKObjectType.workoutType(), HKObjectType.stateOfMindType()]
    }

    /// Observers run on HealthKit's queue, so they get a store of their own off the main actor.
    private nonisolated static let observerStore = HKHealthStore()

    /// Asks HealthKit to wake the app when one of `watchedTypes` gets new data, and calls
    /// `changed` each time. Must be set up again at every launch.
    nonisolated static func watch(_ changed: @escaping @Sendable () async -> Void) {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        for type in watchedTypes() {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { _, done, error in
                guard error == nil else { done(); return }
                // HealthKit waits for `done` before it lets the app be suspended again.
                let finish = UncheckedDone(call: done)
                Task {
                    await changed()
                    finish.call()
                }
            }
            observerStore.execute(query)
            observerStore.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in }
        }
    }

    /// Shows Health's sheet, where the user picks what to share (or turns it all on).
    static func requestAccess() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw PhoneReadError.unavailable("Health") }
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    /// The last `days` days, today included: every type that holds data the user allowed.
    /// A type the user did not allow reads as empty, so it is simply left out.
    static func read(days: Int = 90, now: Date = .now, calendar: Calendar = .current) async throws -> HealthData {
        guard HKHealthStore.isHealthDataAvailable() else { throw PhoneReadError.unavailable("Health") }
        let today = calendar.startOfDay(for: now)
        let start = calendar.date(byAdding: .day, value: -(days - 1), to: today) ?? today
        let window = HKQuery.predicateForSamples(withStart: start, end: now)
        return HealthData(
            profile: profile(),
            metrics: await metrics(from: start, to: now, window: window, calendar: calendar),
            categories: await categoryDays(window: window, calendar: calendar),
            sleep: await sleep(from: start, to: now, calendar: calendar),
            moods: await moods(window: window),
            workouts: await workouts(window: window))
    }

    private static func profile() -> HealthProfile? {
        var p = HealthProfile()
        if let birth = try? store.dateOfBirthComponents(), let year = birth.year, let month = birth.month, let day = birth.day {
            p.birthDate = String(format: "%04d-%02d-%02d", year, month, day)
        }
        switch (try? store.biologicalSex())?.biologicalSex {
        case .female: p.sex = "female"
        case .male: p.sex = "male"
        case .other: p.sex = "other"
        default: break
        }
        switch (try? store.bloodType())?.bloodType {
        case .aPositive: p.bloodType = "A+"
        case .aNegative: p.bloodType = "A-"
        case .bPositive: p.bloodType = "B+"
        case .bNegative: p.bloodType = "B-"
        case .abPositive: p.bloodType = "AB+"
        case .abNegative: p.bloodType = "AB-"
        case .oPositive: p.bloodType = "O+"
        case .oNegative: p.bloodType = "O-"
        default: break
        }
        if let skin = (try? store.fitzpatrickSkinType())?.skinType, skin != .notSet {
            p.skinType = "Fitzpatrick type \(["", "I", "II", "III", "IV", "V", "VI"][min(skin.rawValue, 6)])"
        }
        switch (try? store.wheelchairUse())?.wheelchairUse {
        case .yes: p.wheelchair = true
        case .no: p.wheelchair = false
        default: break
        }
        return p.isEmpty ? nil : p
    }

    private static func metrics(from start: Date, to end: Date, window: NSPredicate, calendar: Calendar) async -> [HealthMetric] {
        var out: [HealthMetric] = []
        for id in quantities {
            let type = HKQuantityType(id)
            // The user's own units (kg or lb, mmol/L or mg/dL); a type without one was not allowed.
            guard let unit = try? await store.preferredUnits(for: [type])[type] else { continue }
            let cumulative = type.aggregationStyle == .cumulative
            let descriptor = HKStatisticsCollectionQueryDescriptor(
                predicate: .quantitySample(type: type, predicate: window),
                options: cumulative ? .cumulativeSum : [.discreteAverage, .discreteMin, .discreteMax],
                anchorDate: start, intervalComponents: DateComponents(day: 1))
            guard let collection = try? await descriptor.result(for: store) else { continue }
            // HealthKit's percent is a fraction; people read 97 %, not 0.97.
            let scale = unit == .percent() ? 100.0 : 1.0
            let read = { (q: HKQuantity?) in q.flatMap { PhoneText.significant($0.doubleValue(for: unit) * scale) } }
            let days = collection.statistics().compactMap { s -> HealthMetricDay? in
                guard let value = read(cumulative ? s.sumQuantity() : s.averageQuantity()) else { return nil }
                return HealthMetricDay(date: PhoneText.day(s.startDate, calendar: calendar), value: value,
                                       min: cumulative ? nil : read(s.minimumQuantity()), max: cumulative ? nil : read(s.maximumQuantity()))
            }
            guard !days.isEmpty else { continue }
            let name = HealthNames.type(id.rawValue)
            out.append(HealthMetric(type: name, name: HealthNames.name(name), unit: scale == 100 ? "%" : unit.unitString,
                                    aggregation: cumulative ? "sum" : "average", days: days.sorted { $0.date > $1.date }))
        }
        return out
    }

    private static func categoryDays(window: NSPredicate, calendar: Calendar) async -> [HealthCategory] {
        var out: [HealthCategory] = []
        for id in categories {
            let query = HKSampleQueryDescriptor(predicates: [.categorySample(type: HKCategoryType(id), predicate: window)], sortDescriptors: [])
            guard let samples = try? await query.result(for: store), !samples.isEmpty else { continue }
            let type = HealthNames.type(id.rawValue)
            var days: [String: HealthCategoryDay] = [:]
            for sample in samples {
                // A stand hour is logged every hour, stood or not: only the stood ones count.
                if id == .appleStandHour, sample.value != HKCategoryValueAppleStandHour.stood.rawValue { continue }
                let date = PhoneText.day(sample.startDate, calendar: calendar)
                var day = days[date] ?? HealthCategoryDay(date: date, count: 0)
                day.count += 1
                let minutes = sample.endDate.timeIntervalSince(sample.startDate) / 60
                if minutes >= 1, id != .appleStandHour { day.minutes = (day.minutes ?? 0) + minutes }
                if let label = HealthCategoryValues.label(type: type, value: sample.value), !(day.values ?? []).contains(label) {
                    day.values = Array(((day.values ?? []) + [label]).prefix(12))
                }
                days[date] = day
            }
            let list = days.values.map { d in var d = d; d.minutes = d.minutes.flatMap { PhoneText.round($0, digits: 0) }; return d }
            guard !list.isEmpty else { continue }
            out.append(HealthCategory(type: type, name: HealthNames.name(type), days: list.sorted { $0.date > $1.date }))
        }
        return out
    }

    private static func sleep(from start: Date, to end: Date, calendar: Calendar) async -> [SleepNight] {
        // A night that began before the window still counts toward its first morning.
        let query = HKSampleQueryDescriptor(
            predicates: [.categorySample(type: HKCategoryType(.sleepAnalysis), predicate: HKQuery.predicateForSamples(withStart: start.addingTimeInterval(-12 * 3600), end: end))],
            sortDescriptors: [])
        let samples = ((try? await query.result(for: store)) ?? []).compactMap { s -> (interval: DateInterval, stage: SleepStage)? in
            let stage: SleepStage? = switch HKCategoryValueSleepAnalysis(rawValue: s.value) {
            case .inBed: .inBed
            case .asleepUnspecified: .asleep
            case .asleepCore: .core
            case .asleepDeep: .deep
            case .asleepREM: .rem
            case .awake: .awake
            default: nil
            }
            return stage.map { (DateInterval(start: s.startDate, end: max(s.endDate, s.startDate)), $0) }
        }
        let first = PhoneText.day(start, calendar: calendar)
        return SleepTotals.nights(samples, calendar: calendar).filter { $0.date >= first }
    }

    private static let moodLabels: [HKStateOfMind.Label: String] = [
        .amazed: "amazed", .amused: "amused", .angry: "angry", .anxious: "anxious", .ashamed: "ashamed", .brave: "brave", .calm: "calm", .content: "content", .disappointed: "disappointed", .discouraged: "discouraged", .disgusted: "disgusted", .embarrassed: "embarrassed", .excited: "excited", .frustrated: "frustrated", .grateful: "grateful", .guilty: "guilty", .happy: "happy", .hopeless: "hopeless", .irritated: "irritated", .jealous: "jealous", .joyful: "joyful", .lonely: "lonely", .passionate: "passionate", .peaceful: "peaceful", .proud: "proud", .relieved: "relieved", .sad: "sad", .scared: "scared", .stressed: "stressed", .surprised: "surprised", .worried: "worried", .annoyed: "annoyed", .confident: "confident", .drained: "drained", .hopeful: "hopeful", .indifferent: "indifferent", .overwhelmed: "overwhelmed", .satisfied: "satisfied",
    ]
    private static let moodAssociations: [HKStateOfMind.Association: String] = [
        .community: "community", .currentEvents: "current events", .dating: "dating", .education: "education", .family: "family", .fitness: "fitness", .friends: "friends", .health: "health", .hobbies: "hobbies", .identity: "identity", .money: "money", .partner: "partner", .selfCare: "self care", .spirituality: "spirituality", .tasks: "tasks", .travel: "travel", .work: "work", .weather: "weather",
    ]

    private static func moods(window: NSPredicate) async -> [HealthMood] {
        let query = HKSampleQueryDescriptor(predicates: [.stateOfMind(window)], sortDescriptors: [SortDescriptor(\.startDate, order: .reverse)], limit: 1000)
        return ((try? await query.result(for: store)) ?? []).map { m in
            HealthMood(at: m.startDate.ISO8601Format(), kind: m.kind == .dailyMood ? "daily" : "momentary",
                       valence: min(max(PhoneText.round(m.valence, digits: 2) ?? 0, -1), 1),
                       labels: m.labels.compactMap { moodLabels[$0] }, associations: m.associations.compactMap { moodAssociations[$0] })
        }
    }

    private static func workouts(window: NSPredicate) async -> [HealthWorkout] {
        let query = HKSampleQueryDescriptor(predicates: [.workout(window)], sortDescriptors: [SortDescriptor(\.startDate, order: .reverse)], limit: 500)
        return ((try? await query.result(for: store)) ?? []).map { w in
            let distance = [HKQuantityTypeIdentifier.distanceWalkingRunning, .distanceCycling, .distanceSwimming, .distanceRowing,
                            .distancePaddleSports, .distanceCrossCountrySkiing, .distanceDownhillSnowSports, .distanceWheelchair]
                .lazy.compactMap { w.statistics(for: HKQuantityType($0))?.sumQuantity()?.doubleValue(for: .meterUnit(with: .kilo)) }
                .first
            return HealthWorkout(
                type: name(of: w.workoutActivityType),
                start: w.startDate.ISO8601Format(),
                minutes: PhoneText.round(w.duration / 60, digits: 0) ?? 0,
                energyKcal: PhoneText.round(w.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()?.doubleValue(for: .kilocalorie()), digits: 0),
                distanceKm: PhoneText.round(distance, digits: 2))
        }
    }

    private static func name(of type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: "Running"
        case .walking: "Walking"
        case .hiking: "Hiking"
        case .cycling: "Cycling"
        case .swimming: "Swimming"
        case .yoga: "Yoga"
        case .pilates: "Pilates"
        case .traditionalStrengthTraining, .functionalStrengthTraining: "Strength training"
        case .coreTraining: "Core training"
        case .highIntensityIntervalTraining: "HIIT"
        case .elliptical: "Elliptical"
        case .rowing: "Rowing"
        case .stairClimbing, .stairs: "Stairs"
        case .cardioDance, .socialDance: "Dance"
        case .mixedCardio: "Cardio"
        case .soccer: "Football"
        case .basketball: "Basketball"
        case .tennis: "Tennis"
        case .badminton: "Badminton"
        case .tableTennis: "Table tennis"
        case .martialArts: "Martial arts"
        case .mindAndBody: "Mind and body"
        default: "Workout"
        }
    }
}

/// HealthKit's completion handler, carried into the task that finishes the work.
private nonisolated struct UncheckedDone: @unchecked Sendable {
    let call: () -> Void
}

enum CalendarReader {
    static let store = EKEventStore()

    static func requestAccess() async throws {
        guard try await store.requestFullAccessToEvents() else { throw PhoneReadError.denied("your calendar") }
    }

    /// From the start of yesterday to a month ahead, soonest first.
    static func read(now: Date = .now, calendar: Calendar = .current) throws -> CalendarData {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { throw PhoneReadError.denied("your calendar") }
        let start = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: now)) ?? now
        let end = calendar.date(byAdding: .day, value: 32, to: start) ?? now
        let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
            .sorted { $0.startDate < $1.startDate }
            .prefix(400)
        return CalendarData(events: events.map { e in
            // EventKit ends an all-day event at 23:59:59 of its last day, so it stays on its own days.
            let ends: Date? = e.endDate
            return CalendarEventData(
                title: PhoneText.clip(e.title, max: 200) ?? "Untitled",
                start: e.startDate.ISO8601Format(),
                end: ends.map { max($0, e.startDate).ISO8601Format() },
                allDay: e.isAllDay,
                location: PhoneText.clip(e.location, max: 300),
                calendar: PhoneText.clip(e.calendar?.title, max: 100),
                notes: PhoneText.clip(e.notes, max: 500))
        })
    }
}

enum RemindersReader {
    static func requestAccess() async throws {
        guard try await CalendarReader.store.requestFullAccessToReminders() else { throw PhoneReadError.denied("your reminders") }
    }

    static func read() async throws -> RemindersData {
        guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else { throw PhoneReadError.denied("your reminders") }
        let store = CalendarReader.store
        return await withCheckedContinuation { continuation in
            fetch(store) { continuation.resume(returning: $0) }
        }
    }

    /// Reminders arrive on a background queue: read them there, off the main actor.
    private nonisolated static func fetch(_ store: EKEventStore, completion: @escaping @Sendable (RemindersData) -> Void) {
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        store.fetchReminders(matching: predicate) { reminders in
            let calendar = Calendar.current
            let items = (reminders ?? []).prefix(400).map { r in
                let due = r.dueDateComponents.flatMap { calendar.date(from: $0) }
                return ReminderData(
                    title: PhoneText.clip(r.title, max: 300) ?? "Untitled",
                    due: due?.ISO8601Format(),
                    allDay: due == nil ? nil : r.dueDateComponents?.hour == nil,
                    list: PhoneText.clip(r.calendar?.title, max: 100),
                    priority: r.priority == 0 ? nil : min(max(r.priority, 0), 9),
                    notes: PhoneText.clip(r.notes, max: 500))
            }
            completion(RemindersData(items: Array(items)))
        }
    }
}

enum LocationReader {
    /// Where the phone is, to the town. Asks for permission the first time.
    static func read(timeout: Duration = .seconds(20)) async throws -> LocationData {
        try await withThrowingTaskGroup(of: LocationData.self) { group in
            group.addTask { try await locate() }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw PhoneReadError.timedOut
            }
            defer { group.cancelAll() }
            guard let found = try await group.next() else { throw PhoneReadError.timedOut }
            return found
        }
    }

    private static func locate() async throws -> LocationData {
        #if os(iOS)
        let session = CLServiceSession(authorization: .whenInUse)
        defer { session.invalidate() }
        #endif
        // The Mac has no service sessions: the first update asks for permission by itself.
        for try await update in CLLocationUpdate.liveUpdates() {
            if update.authorizationDenied || update.authorizationDeniedGlobally || update.authorizationRestricted {
                throw PhoneReadError.denied("your location")
            }
            guard let location = update.location, location.horizontalAccuracy >= 0 else { continue }
            let item = try? await MKReverseGeocodingRequest(location: location)?.mapItems.first
            let names = item?.addressRepresentations
            let place = PhoneText.clip(names?.cityName ?? names?.cityWithContext, max: 120)
            // Two decimals is about a kilometre: enough for the weather, not an address.
            return LocationData(
                place: place ?? "Unknown place",
                region: nil,
                country: PhoneText.clip(names?.regionName, max: 80),
                latitude: PhoneText.round(location.coordinate.latitude, digits: 2),
                longitude: PhoneText.round(location.coordinate.longitude, digits: 2))
        }
        throw PhoneReadError.timedOut
    }
}
