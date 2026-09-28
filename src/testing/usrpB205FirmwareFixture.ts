import { USRP_B205_FIRMWARE, type VerifiedUsrpB205Firmware } from "../radio/usrpB205Firmware";

export function usrpB205FirmwareFixture(): VerifiedUsrpB205Firmware {
  return {
    contract: USRP_B205_FIRMWARE,
    text: ":0400000540019DEC2D\n:00000001FF\n",
    importedAs: "official-member",
    archiveSha256: null,
    memberSha256: USRP_B205_FIRMWARE.memberSha256,
  };
}
