import Contacts
import CoreLocation
import Foundation
import MapKit
#if os(iOS)
import MediaPlayer
#endif
import Photos

// The phone's own libraries: contacts, music and photos. Reading thousands of records is slow,
// so each enumerates off the main actor; what it returns is plain data.

enum ContactsReader {
    static func requestAccess() async throws {
        guard try await CNContactStore().requestAccess(for: .contacts) else { throw PhoneReadError.denied("your contacts") }
    }

    static func read() async throws -> ContactsData {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        #if os(iOS)
        guard status == .authorized || status == .limited else { throw PhoneReadError.denied("your contacts") }
        #else
        guard status == .authorized else { throw PhoneReadError.denied("your contacts") }
        #endif
        return try await Task.detached(priority: .utility) { try fetch() }.value
    }

    private nonisolated static func fetch() throws -> ContactsData {
        let keys: [CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactNicknameKey as CNKeyDescriptor, CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactJobTitleKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor, CNContactBirthdayKey as CNKeyDescriptor,
            CNContactRelationsKey as CNKeyDescriptor, CNContactPostalAddressesKey as CNKeyDescriptor,
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.sortOrder = .userDefault
        var contacts: [ContactData] = []
        let label = { (raw: String?) in raw.map { CNLabeledValue<NSString>.localizedString(forLabel: $0) }.flatMap { PhoneText.clip($0, max: 60) } }
        try CNContactStore().enumerateContacts(with: request) { c, stop in
            let name = PhoneText.clip(CNContactFormatter.string(from: c, style: .fullName), max: 200)
                ?? PhoneText.clip(c.organizationName, max: 200)
            guard let name else { return }
            contacts.append(ContactData(
                name: name,
                nickname: PhoneText.clip(c.nickname, max: 100),
                organization: PhoneText.clip(c.organizationName, max: 200),
                jobTitle: PhoneText.clip(c.jobTitle, max: 200),
                phones: c.phoneNumbers.prefix(10).compactMap { p in
                    PhoneText.clip(p.value.stringValue, max: 200).map { LabelledValue(label: label(p.label), value: $0) }
                },
                emails: c.emailAddresses.prefix(10).compactMap { e in
                    PhoneText.clip(e.value as String, max: 200).map { LabelledValue(label: label(e.label), value: $0) }
                },
                birthday: PhoneText.birthday(c.birthday),
                relations: c.contactRelations.prefix(10).compactMap { r in
                    guard let who = PhoneText.clip(r.value.name, max: 200) else { return nil }
                    return ContactRelation(label: label(r.label) ?? "relation", name: who)
                },
                city: PhoneText.clip(c.postalAddresses.first?.value.city, max: 120)))
            if contacts.count >= 5000 { stop.pointee = true }
        }
        return ContactsData(contacts: contacts)
    }
}

#if os(iOS)
enum MusicReader {
    static func requestAccess() async throws {
        guard await MPMediaLibrary.requestAuthorization() == .authorized else { throw PhoneReadError.denied("your music library") }
    }

    static func read(now: Date = .now) async throws -> MusicData {
        guard MPMediaLibrary.authorizationStatus() == .authorized else { throw PhoneReadError.denied("your music library") }
        let songs = await Task.detached(priority: .utility) { fetch() }.value
        return MusicSummary.make(songs, now: now)
    }

    private nonisolated static func fetch() -> [SongStat] {
        (MPMediaQuery.songs().items ?? []).compactMap { item in
            guard let title = item.title else { return nil }
            return SongStat(title: title, artist: item.artist, album: item.albumTitle, genre: item.genre,
                            plays: item.playCount, lastPlayed: item.lastPlayedDate)
        }
    }
}
#else
/// The Mac has no media library to read (Music is shared from the iPhone).
enum MusicReader {
    static func requestAccess() async throws { throw PhoneReadError.unavailable("Your music library") }
    static func read(now: Date = .now) async throws -> MusicData { throw PhoneReadError.unavailable("Your music library") }
}
#endif

enum PhotosReader {
    /// Town names for map squares already looked up, so each is asked for once.
    private static let namesKey = "phone.photos.places"

    static func requestAccess() async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else { throw PhoneReadError.denied("your photos") }
    }

    /// The past year a day at a time. Up to `lookups` new places are named per send: Apple limits
    /// how fast names may be asked for, and a library fills in over a few sends.
    static func read(now: Date = .now, lookups: Int = 30) async throws -> PhotosData {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { throw PhoneReadError.denied("your photos") }
        let since = now.addingTimeInterval(-365 * 86_400)
        let (total, stats) = await Task.detached(priority: .utility) { fetch(since: since) }.value
        var names = UserDefaults.standard.dictionary(forKey: namesKey) as? [String: String] ?? [:]
        var asked = 0
        for cell in PhotoSummary.cellsByCount(stats) where names[cell] == nil && asked < lookups {
            asked += 1
            let parts = cell.split(separator: ",").compactMap { Double($0) }
            guard parts.count == 2, let name = await PlaceNamer.town(latitude: parts[0], longitude: parts[1]) else { continue }
            names[cell] = name
        }
        UserDefaults.standard.set(names, forKey: namesKey)
        return PhotosData(total: total, days: PhotoSummary.days(stats, names: names))
    }

    private nonisolated static func fetch(since: Date) -> (Int, [PhotoStat]) {
        let total = PHAsset.fetchAssets(with: nil).count
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "creationDate >= %@", since as NSDate)
        var stats: [PhotoStat] = []
        PHAsset.fetchAssets(with: options).enumerateObjects { asset, _, _ in
            guard let date = asset.creationDate else { return }
            let cell = asset.location.map { PhotoSummary.cell(latitude: $0.coordinate.latitude, longitude: $0.coordinate.longitude) }
            stats.append(PhotoStat(date: date, isVideo: asset.mediaType == .video, isFavorite: asset.isFavorite, cell: cell))
        }
        return (total, stats)
    }
}

/// Names for coordinates, through MapKit (the app sends nowhere else to ask).
enum PlaceNamer {
    /// "Ubud, Bali": the town and its region.
    static func town(latitude: Double, longitude: Double) async -> String? {
        let item = try? await MKReverseGeocodingRequest(location: CLLocation(latitude: latitude, longitude: longitude))?.mapItems.first
        return PhoneText.clip(item?.addressRepresentations?.cityWithContext ?? item?.addressRepresentations?.cityName, max: 120)
    }

    /// The place itself when MapKit knows one ("Kopi Tuku"), else its street and town.
    static func spot(latitude: Double, longitude: Double) async -> String? {
        let item = try? await MKReverseGeocodingRequest(location: CLLocation(latitude: latitude, longitude: longitude))?.mapItems.first
        let address = item?.addressRepresentations?.fullAddress(includingRegion: false, singleLine: true)
        return PhoneText.clip(item?.name ?? address, max: 200)
    }
}
