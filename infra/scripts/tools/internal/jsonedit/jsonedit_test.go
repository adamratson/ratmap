package jsonedit

import (
	"encoding/json"
	"testing"
)

func TestSetAndDelete(t *testing.T) {
	cases := []struct {
		in, op, key, value, want string
	}{
		{`{"a":1,"ele":"1345","b":2}`, "set", "ele", `1345.0`, `{"a":1,"ele":1345.0,"b":2}`},
		{`{"a":1}`, "set", "lists", `"munro"`, `{"a":1,"lists":"munro"}`},
		{`{}`, "set", "lists", `"munro"`, `{"lists":"munro"}`},
		{`{ }`, "set", "k", `1`, `{"k":1}`},
		{`{"ele":"x","a":1}`, "del", "ele", ``, `{"a":1}`},
		{`{"a":1,"ele":"x","b":2}`, "del", "ele", ``, `{"a":1,"b":2}`},
		{`{"a":1,"ele":"x"}`, "del", "ele", ``, `{"a":1}`},
		{`{"a": 1, "ele": "x"}`, "del", "ele", ``, `{"a": 1}`},
		{`{"ele":"x"}`, "del", "ele", ``, `{}`},
		{`{"a":1}`, "del", "ele", ``, `{"a":1}`},
		// Strings holding braces, quotes and commas must not confuse the scanner.
		{`{"n":"a,\"}\",b","x":[1,{"y":"}"}],"ele":"1"}`, "del", "ele", ``, `{"n":"a,\"}\",b","x":[1,{"y":"}"}]}`},
		{`{"ele":"1","a":2}`, "del", "ele", ``, `{"a":2}`},
	}
	for _, c := range cases {
		o, err := Parse([]byte(c.in), 0)
		if err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		var got []byte
		if c.op == "set" {
			got, err = o.Set([]byte(c.in), c.key, []byte(c.value))
		} else {
			got, err = o.Delete([]byte(c.in), c.key)
		}
		if err != nil {
			t.Fatalf("%s %s %s: %v", c.op, c.key, c.in, err)
		}
		if string(got) != c.want {
			t.Errorf("%s %s on %s\n got  %s\n want %s", c.op, c.key, c.in, got, c.want)
		}
		if !json.Valid(got) {
			t.Errorf("%s: result is not JSON", got)
		}
	}
}

func TestDuplicateKeyRefused(t *testing.T) {
	o, _ := Parse([]byte(`{"ele":1,"ele":2}`), 0)
	if _, err := o.Find("ele"); err == nil {
		t.Fatal("a repeated key must be refused, not edited in one place")
	}
}
