// Sets a foldable iOS Simulator's hinge angle from inside the simulator:
//   xcrun simctl spawn <udid> ./simhinge <degrees>
// It sends the vendor-defined HID event Device Hub's hinge slider sends. The event format is
// private and undocumented (seen in artemnovichkov/hinge, MIT); verified only on Xcode 27.1.
#import <Foundation/Foundation.h>
#import <IOKit/IOKitLib.h>
#include <mach/mach_time.h>

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;
extern IOHIDEventSystemClientRef IOHIDEventSystemClientCreateWithType(CFAllocatorRef, int, CFDictionaryRef);
extern IOHIDEventRef IOHIDEventCreateVendorDefinedEvent(CFAllocatorRef, uint64_t, uint32_t, uint32_t,
    uint32_t, const uint8_t *, CFIndex, uint32_t);
extern void IOHIDEventSystemClientDispatchEvent(IOHIDEventSystemClientRef, IOHIDEventRef);
// In IOKit, but the iOS Simulator SDK's headers leave it out.
extern CFDataRef IOCFSerialize(CFTypeRef object, CFOptionFlags options);

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: simhinge <degrees 0-180>\n");
    return 2;
  }
  double degrees = fmin(fmax(atof(argv[1]), 0), 180);
  IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreateWithType(NULL, 4, NULL);
  if (!client) {
    fprintf(stderr, "no HID event client\n");
    return 1;
  }
  NSDictionary *payload = @{
    @"provider": @"com.apple.Virtualization.VirtualMachines",
    @"source": @"hinge-slider-control",
    @"type": @"range",
    @"value": @(degrees),
  };
  CFDataRef data = IOCFSerialize((__bridge CFTypeRef)payload, 1);
  IOHIDEventRef event = IOHIDEventCreateVendorDefinedEvent(NULL, mach_absolute_time(), 0xFF61, 0x5B, 0,
      CFDataGetBytePtr(data), CFDataGetLength(data), 0);
  IOHIDEventSystemClientDispatchEvent(client, event);
  CFRelease(event);
  CFRelease(data);
  usleep(200000);
  printf("sent %.1f\n", degrees);
  return 0;
}
