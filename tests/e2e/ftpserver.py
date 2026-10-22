import sys
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer
port, root, user, pw = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
a = DummyAuthorizer(); a.add_user(user, pw, root, perm='elradfmwMT')
h = FTPHandler; h.authorizer = a
FTPServer(('127.0.0.1', port), h).serve_forever()
