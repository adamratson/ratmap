import hashlib, os, sys
st = os.stat(sys.argv[1])
union = hashlib.sha1(" ".join(sys.argv[2].split()).encode()).hexdigest()[:12]
print(f"{union}-{st.st_size}-{int(st.st_mtime)}")