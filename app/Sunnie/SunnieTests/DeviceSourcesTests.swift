import Testing
@testable import Sunnie

struct DeviceSourcesTests {
    @Test func eachPlatformOffersWhatItCanRead() {
        #if os(macOS)
        // No Health data or music library on a Mac, and its visit log would replace the iPhone's.
        #expect(PhoneSource.onThisDevice == [.calendar, .reminders, .location, .contacts, .photos])
        #expect(DeviceName.this == "this Mac")
        #else
        #expect(PhoneSource.onThisDevice == PhoneSource.allCases)
        #expect(DeviceName.this == "this iPhone")
        #endif
    }
}
