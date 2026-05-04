# Re:OS build / install on macOS.
#
# Usage:
#   make           # alias for `make install`
#   make build     # `tauri build` (release)
#   make install   # build + copy ReOS.app into /Applications
#   make uninstall # remove the installed app
#   make clean     # remove build artifacts (frontend + rust target)

APP_NAME    := ReOS.app
BUNDLE_DIR  := src-tauri/target/release/bundle/macos
APP_BUNDLE  := $(BUNDLE_DIR)/$(APP_NAME)
INSTALL_DIR := /Applications
INSTALLED   := $(INSTALL_DIR)/$(APP_NAME)

.PHONY: all build install uninstall clean check verify-install help

all: install

help:
	@echo "Targets:"
	@echo "  build     - build the release bundle ($(APP_BUNDLE))"
	@echo "  install   - build and copy to $(INSTALLED)"
	@echo "  uninstall - remove $(INSTALLED)"
	@echo "  clean     - remove build artifacts"
	@echo "  check     - run svelte-check"

# Build only when sources are newer than the bundled app.
$(APP_BUNDLE): $(shell find src src-tauri/src src-tauri/resources -type f 2>/dev/null) src-tauri/tauri.conf.json src-tauri/Cargo.toml package.json
	npm install
	npm run build

build: $(APP_BUNDLE)

install: build
	@if [ -d "$(INSTALLED)" ]; then \
		echo "Removing existing $(INSTALLED)…"; \
		rm -rf "$(INSTALLED)"; \
	fi
	@echo "Copying $(APP_NAME) to $(INSTALL_DIR)…"
	cp -R "$(APP_BUNDLE)" "$(INSTALLED)"
	@echo "Clearing macOS quarantine attribute…"
	-xattr -dr com.apple.quarantine "$(INSTALLED)"
	@echo "Installed: $(INSTALLED)"

uninstall:
	@if [ -d "$(INSTALLED)" ]; then \
		echo "Removing $(INSTALLED)…"; \
		rm -rf "$(INSTALLED)"; \
		echo "Removed."; \
	else \
		echo "Not installed: $(INSTALLED)"; \
	fi

clean:
	rm -rf build
	rm -rf src-tauri/target

check:
	npm run check

verify-install:
	@test -d "$(INSTALLED)" && echo "OK: $(INSTALLED) exists" || (echo "MISSING: $(INSTALLED)"; exit 1)
	@test -x "$(INSTALLED)/Contents/MacOS/reos-standalone" && echo "OK: binary executable present" || (echo "MISSING binary"; exit 1)
	@test -d "$(INSTALLED)/Contents/Resources/reos-skills/.claude/skills/summarize-paper" && echo "OK: summarize-paper skill bundled" || (echo "MISSING summarize-paper skill"; exit 1)
	@test -d "$(INSTALLED)/Contents/Resources/reos-skills/.claude/skills/navigate-thread" && echo "OK: navigate-thread skill bundled" || (echo "MISSING navigate-thread skill"; exit 1)
	@/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$(INSTALLED)/Contents/Info.plist"
	@/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$(INSTALLED)/Contents/Info.plist"
