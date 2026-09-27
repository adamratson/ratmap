// Package shell writes values for bash to read back.
package shell

import "strings"

// Quote makes s one shell word: unchanged if it is non-empty and only ASCII letters,
// digits and _@%+=:,./- , otherwise single-quoted with each ' written as '"'"'.
func Quote(s string) string {
	if s == "" {
		return "''"
	}
	safe := true
	for _, r := range s {
		if !(r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			strings.ContainsRune("@%+=:,./-", r)) {
			safe = false
			break
		}
	}
	if safe {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}
