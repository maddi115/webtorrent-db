#include <emscripten/bind.h>
#include <string>
#include <sstream>
#include <iomanip>

using namespace emscripten;

// Simple FNV-1a hash implementation
unsigned int hashString(const std::string& str) {
    const unsigned int FNV_PRIME = 16777619u;
    unsigned int hash = 2166136261u;
    
    for (char c : str) {
        hash ^= static_cast<unsigned int>(c);
        hash *= FNV_PRIME;
    }
    
    return hash;
}

// Convert hash to hex string
std::string hashToHex(unsigned int hash) {
    std::stringstream ss;
    ss << std::hex << std::setw(8) << std::setfill('0') << hash;
    return ss.str();
}

// Hash a content ID
std::string hashContentId(const std::string& contentId) {
    return hashToHex(hashString(contentId));
}

EMSCRIPTEN_BINDINGS(hash_module) {
    function("hashString", &hashString);
    function("hashToHex", &hashToHex);
    function("hashContentId", &hashContentId);
}
