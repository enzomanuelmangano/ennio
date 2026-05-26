//
// EnnioHandlers.mm
//
// Entry point that wires every socket op into EnnioControlSocket on
// dylib load. The handler bodies live in domain-specific files in
// this folder (see headers for the op lists):
//
//   EnnioFindHandlers         locate-by-testID / text / index / hit-test
//   EnnioWaitHandlers         frame-hash / React-commit / VC-transition gates
//   EnnioInteractionHandlers  tap / activate / focus / type / swipe
//   EnnioSystemHandlers       diagnostic / alerts / scroll / clipboard / clear-state
//
// One +load on the EnnioHandlers class calls the four register
// functions in a fixed order so the registration sequence is explicit
// and debuggable. Splitting +load across multiple files would make the
// order race-y (ObjC class +load runs in linkage order, which is
// fragile across pod/static-lib boundaries).
//

#import "EnnioFindHandlers.h"
#import "EnnioInteractionHandlers.h"
#import "EnnioSystemHandlers.h"
#import "EnnioWaitHandlers.h"

#import <Foundation/Foundation.h>

@interface EnnioHandlers : NSObject
@end

@implementation EnnioHandlers

+ (void)load {
    RegisterEnnioFindHandlers();
    RegisterEnnioWaitHandlers();
    RegisterEnnioInteractionHandlers();
    RegisterEnnioSystemHandlers();
}

@end
