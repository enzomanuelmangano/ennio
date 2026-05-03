#pragma once

#include <string>
#include <sstream>
#include <iostream>
#include <chrono>
#include <iomanip>

namespace tasto {

/**
 * Log levels for Tasto debugging
 */
enum class LogLevel {
    Error = 0,
    Warn = 1,
    Info = 2,
    Debug = 3,
    Trace = 4
};

/**
 * TastoLog provides structured logging for the native module.
 *
 * Logging is controlled by the TASTO_DEBUG environment variable:
 * - Not set or "0": No logging
 * - "1": Error and Warn only
 * - "2": Info level
 * - "3": Debug level
 * - "4": Trace level (verbose)
 *
 * In a compiled app, use TASTO_DEBUG preprocessor flag.
 */
class TastoLog {
public:
    /**
     * Get the current log level
     */
    static LogLevel getLevel() {
#ifdef TASTO_DEBUG
#if TASTO_DEBUG >= 4
        return LogLevel::Trace;
#elif TASTO_DEBUG >= 3
        return LogLevel::Debug;
#elif TASTO_DEBUG >= 2
        return LogLevel::Info;
#elif TASTO_DEBUG >= 1
        return LogLevel::Warn;
#else
        return LogLevel::Error;
#endif
#else
        // In release builds, default to no logging
        return LogLevel::Error;
#endif
    }

    /**
     * Check if a log level is enabled
     */
    static bool isEnabled(LogLevel level) {
        return static_cast<int>(level) <= static_cast<int>(getLevel());
    }

    /**
     * Log a message at the given level
     */
    static void log(LogLevel level, const std::string& tag, const std::string& message) {
        if (!isEnabled(level)) {
            return;
        }

        // Get timestamp
        auto now = std::chrono::system_clock::now();
        auto time = std::chrono::system_clock::to_time_t(now);
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            now.time_since_epoch()
        ).count() % 1000;

        // Get level string
        const char* levelStr = "???";
        switch (level) {
            case LogLevel::Error: levelStr = "ERR"; break;
            case LogLevel::Warn:  levelStr = "WRN"; break;
            case LogLevel::Info:  levelStr = "INF"; break;
            case LogLevel::Debug: levelStr = "DBG"; break;
            case LogLevel::Trace: levelStr = "TRC"; break;
        }

        // Format: [HH:MM:SS.mmm] [LEVEL] [TAG] Message
        std::ostringstream oss;
        oss << std::put_time(std::localtime(&time), "%H:%M:%S");
        oss << "." << std::setfill('0') << std::setw(3) << ms;
        oss << " [" << levelStr << "] [" << tag << "] " << message;

        // Output to stderr (always available)
        std::cerr << oss.str() << std::endl;
    }

    // Convenience methods
    static void error(const std::string& tag, const std::string& message) {
        log(LogLevel::Error, tag, message);
    }

    static void warn(const std::string& tag, const std::string& message) {
        log(LogLevel::Warn, tag, message);
    }

    static void info(const std::string& tag, const std::string& message) {
        log(LogLevel::Info, tag, message);
    }

    static void debug(const std::string& tag, const std::string& message) {
        log(LogLevel::Debug, tag, message);
    }

    static void trace(const std::string& tag, const std::string& message) {
        log(LogLevel::Trace, tag, message);
    }
};

// ============================================
// Logging Macros
// ============================================

// These macros are completely compiled out when TASTO_DEBUG is not defined
// or when the level is higher than the configured level

#ifdef TASTO_DEBUG

#define TASTO_LOG_ERROR(tag, msg) ::tasto::TastoLog::error(tag, msg)
#define TASTO_LOG_WARN(tag, msg)  ::tasto::TastoLog::warn(tag, msg)

#if TASTO_DEBUG >= 2
#define TASTO_LOG_INFO(tag, msg)  ::tasto::TastoLog::info(tag, msg)
#else
#define TASTO_LOG_INFO(tag, msg)  do {} while(0)
#endif

#if TASTO_DEBUG >= 3
#define TASTO_LOG_DEBUG(tag, msg) ::tasto::TastoLog::debug(tag, msg)
#else
#define TASTO_LOG_DEBUG(tag, msg) do {} while(0)
#endif

#if TASTO_DEBUG >= 4
#define TASTO_LOG_TRACE(tag, msg) ::tasto::TastoLog::trace(tag, msg)
#else
#define TASTO_LOG_TRACE(tag, msg) do {} while(0)
#endif

// Format helper for building messages with stream syntax
#define TASTO_LOG_FMT(...) ([]() { \
    std::ostringstream _oss; \
    _oss << __VA_ARGS__; \
    return _oss.str(); \
}())

// Printf-style format helper for DEBUG level (used by legacy code)
#if TASTO_DEBUG >= 3
#define TASTO_LOG_DEBUG_F(tag, fmt, ...) do { \
    char _buf[512]; \
    snprintf(_buf, sizeof(_buf), fmt, ##__VA_ARGS__); \
    ::tasto::TastoLog::debug(tag, _buf); \
} while(0)
#else
#define TASTO_LOG_DEBUG_F(tag, fmt, ...) do {} while(0)
#endif

#else // TASTO_DEBUG not defined

#define TASTO_LOG_ERROR(tag, msg) do {} while(0)
#define TASTO_LOG_WARN(tag, msg)  do {} while(0)
#define TASTO_LOG_INFO(tag, msg)  do {} while(0)
#define TASTO_LOG_DEBUG(tag, msg) do {} while(0)
#define TASTO_LOG_TRACE(tag, msg) do {} while(0)
#define TASTO_LOG_FMT(...)        std::string()
#define TASTO_LOG_DEBUG_F(tag, fmt, ...) do {} while(0)

#endif // TASTO_DEBUG

} // namespace tasto
