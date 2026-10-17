SET LOCAL ROLE jpegpe_owner;
GRANT EXECUTE ON FUNCTION jpegpe.public_profile_frog(uuid) TO identity_owner;
RESET ROLE;
